// Iris — the orchestrator. The CEO and Iris work together: the chat is a
// conversation (no diffs there); Iris proposes tasks; the CEO creates them, and
// holds the decisive powers — START / STOP a task, and the final CONFIRM-MERGE.
//
// THE SECURITY WALL: push()/openPr()/mergePr() run from exactly one place
// (confirmMerge), inside an `if (canPush(task))` branch. canPush lives in
// @bureau/core and is the sole gate. startTask only commits locally — it never
// pushes — so nothing reaches GitHub until the CEO confirms.

import { transition, canPush } from "@bureau/core";
import type {
  Task,
  TaskId,
  StepId,
  GateId,
  Step,
  Artifact,
  ArtifactId,
  TransitionEvent,
} from "@bureau/core";
import type { CapabilityRegistry } from "@bureau/capabilities";
import type { Provider } from "@bureau/providers";
import type { Message, TaskProposal, ChatResponse } from "@bureau/contracts";
import { join } from "node:path";

import type { TaskStore, VcsPort, EventSink, MessageLog } from "./ports.js";
import { irisRespond } from "./iris.js";

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly status = 500
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export interface OrchestratorConfig {
  readonly repoOwner: string;
  readonly repoName: string;
  readonly baseBranch: string;
  readonly worktreesDir: string;
}

export interface OrchestratorDeps {
  readonly store: TaskStore;
  readonly capabilities: CapabilityRegistry;
  readonly provider: Provider;
  readonly vcs: VcsPort;
  readonly events: EventSink;
  readonly messages: MessageLog;
  readonly config: OrchestratorConfig;
  readonly ids: () => string;
  readonly clock: () => string;
}

export class Orchestrator {
  /** In-flight background pipelines, keyed by task id (for settle / graceful drain). */
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly d: OrchestratorDeps) {}

  /** A conversation turn with Iris. Returns her reply and, maybe, a task proposal. */
  async chat(content: string): Promise<ChatResponse> {
    this.appendMessage("user", content);
    const turn = await irisRespond(this.d.provider, this.d.messages.list());
    const reply = this.appendMessage("iris", turn.reply);
    return turn.proposal ? { reply, proposal: turn.proposal } : { reply };
  }

  /** Await the in-flight pipeline for a task (no-op if none). Used by tests and shutdown. */
  async settle(taskId: string): Promise<void> {
    await this.running.get(taskId);
  }

  /** Await every in-flight pipeline (graceful shutdown drain). */
  async settleAll(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  /** Materialize a proposal into a DRAFT task (created, not started). */
  createTask(proposal: TaskProposal): Task {
    const now = this.d.clock();
    const taskId = this.d.ids();
    const gateId = this.d.ids();
    const lastIdx = proposal.steps.length - 1;
    const steps: Step[] = proposal.steps.map((s, i) => ({
      id: this.d.ids() as StepId,
      capability: s.capability,
      description: s.description,
      acceptanceCriteria: [],
      status: "pending",
      artifactIds: [],
      ...(i === lastIdx ? { gateAfter: gateId as GateId } : {}),
    }));
    const task: Task = {
      id: taskId as TaskId,
      goal: proposal.title,
      repoOwner: this.d.config.repoOwner,
      repoName: this.d.config.repoName,
      status: "created",
      steps,
      // The single human gate is the pr_approval gate — the final confirm-merge.
      gates: [{ id: gateId as GateId, kind: "pr_approval", status: "pending" }],
      artifacts: [],
      decisionLog: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(task);
    this.emitTaskUpdated(task);
    this.appendMessage("iris", `Created task "${proposal.title}". Open it in Tasks and press Start when you're ready.`);
    return task;
  }

  /** Start a draft task. Returns immediately (status `planning`) and runs the
   *  pipeline in the BACKGROUND so the panel can show live progress instead of
   *  blocking on one long request. The pipeline commits locally (NO push) and
   *  parks the task at the review gate for the CEO. */
  async startTask(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (task.status !== "created") {
      throw new OrchestratorError(`Task ${taskId} is not startable (status ${task.status}).`, 409);
    }

    task = this.drive(task, { type: "START_PLANNING" });
    this.emitTaskUpdated(task);
    this.appendMessage("iris", `On it — setting up an isolated workspace and starting the pipeline for "${task.goal}".`, taskId);

    const promise = this.runPipeline(taskId);
    this.running.set(taskId, promise);
    void promise.finally(() => this.running.delete(taskId));
    return task;
  }

  /** The background pipeline. Race-safe against a concurrent stop: it reloads the
   *  task before every transition and bails the moment it's no longer running. */
  private async runPipeline(taskId: string): Promise<void> {
    const branch = this.branchFor(taskId);
    const worktreePath = join(this.d.config.worktreesDir, taskId);
    let currentStepId: StepId | undefined;
    try {
      await this.d.vcs.ensureClone();
      await this.d.vcs.setupWorktree(branch, worktreePath);

      let task = this.requireTask(taskId);
      if (task.status !== "planning") {
        // Stopped during setup — clean up the worktree we just made and bail.
        await this.d.vcs.removeWorktree({ path: worktreePath, branch }, true).catch(() => {});
        return;
      }
      task = this.setWorktree(task, worktreePath);
      task = this.drive(task, { type: "PLANNING_DONE" });
      this.emitTaskUpdated(task);

      for (const planned of task.steps) {
        if (this.requireTask(taskId).status !== "executing") return; // stopped between steps
        currentStepId = planned.id;
        task = this.drive(this.requireTask(taskId), { type: "START_STEP", stepId: planned.id });
        this.d.events.emit({ type: "step_started", taskId, stepId: planned.id });

        const step = task.steps.find((s) => s.id === planned.id)!;
        if (this.d.capabilities.has(step.capability)) {
          const out = await this.d.capabilities.get(step.capability).execute({
            step,
            worktreePath,
            context: task.goal,
          });
          if (this.requireTask(taskId).status !== "executing") return; // stopped during the step
          if (out.artifacts.length > 0) this.addArtifacts(this.requireTask(taskId), out.artifacts);
        }

        this.drive(this.requireTask(taskId), { type: "COMPLETE_STEP", stepId: planned.id });
        currentStepId = undefined;
        this.d.events.emit({ type: "step_completed", taskId, stepId: planned.id });
      }

      // Capture the diff (incl. new files), then commit it locally on the branch.
      const diff = await this.d.vcs.workingDiff(worktreePath);
      await this.d.vcs.commitAll(worktreePath, `Bureau: ${truncate(this.requireTask(taskId).goal)}`);
      task = this.requireTask(taskId);
      if (task.status !== "executing") return; // stopped during commit
      task = this.addArtifacts(task, [
        {
          id: this.d.ids() as ArtifactId,
          kind: "diff",
          ref: diff,
          producedByStep: task.steps[task.steps.length - 1]!.id,
          createdAt: this.d.clock(),
        },
      ]);

      const gate = task.gates[0]!;
      task = this.drive(task, { type: "OPEN_GATE", gateId: gate.id });
      this.d.events.emit({ type: "gate_opened", taskId, gateId: gate.id, gateKind: "pr_approval" });
      this.emitTaskUpdated(task);
      this.appendMessage("iris", `Done — the branch for "${task.goal}" is ready for your review.`, taskId);
    } catch (err) {
      this.failPipeline(taskId, currentStepId, err);
    }
  }

  /** A pipeline error: mark the running step failed (if any), abort the task, and
   *  clean up — best-effort, never throws (it runs in a floating background promise). */
  private failPipeline(taskId: string, stepId: StepId | undefined, err: unknown): void {
    let task: Task;
    try {
      task = this.requireTask(taskId);
    } catch {
      return;
    }
    if (task.status === "aborted" || task.status === "completed") return; // already resolved (e.g. stopped)
    try {
      if (stepId !== undefined && task.steps.find((s) => s.id === stepId)?.status === "running") {
        task = this.drive(task, { type: "FAIL_STEP", stepId, reason: errMessage(err) });
      }
      task = this.drive(task, { type: "ABORT_TASK", reason: errMessage(err) });
      this.emitTaskUpdated(task);
      this.appendMessage("iris", `"${task.goal}" hit a problem and stopped: ${errMessage(err)}.`, taskId);
      if (task.worktreePath !== undefined) {
        void this.d.vcs
          .removeWorktree({ path: task.worktreePath, branch: this.branchFor(taskId) }, true)
          .catch(() => {});
      }
    } catch {
      /* best-effort: a concurrent stop may have already aborted it */
    }
  }

  /** Stop a task: abort and tear down its worktree. Idempotent on terminal tasks. */
  async stopTask(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (task.status === "completed" || task.status === "aborted") return task; // already resolved
    task = this.drive(task, { type: "ABORT_TASK", reason: "Stopped by the CEO." });
    this.emitTaskUpdated(task);
    this.appendMessage("iris", `Stopped "${task.goal}" and cleaned up its workspace.`, taskId);
    if (task.worktreePath !== undefined) {
      try {
        await this.d.vcs.removeWorktree({ path: task.worktreePath, branch: this.branchFor(task.id) }, true);
      } catch {
        /* best-effort: a background step may still hold a file; the worktree is orphaned but safe */
      }
    }
    return task;
  }

  /** The CEO's final confirmation: push, open the PR, squash-merge to main, clean up.
   *  This is the ONE code path that reaches GitHub, and only when canPush()===true. */
  async confirmMerge(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    const gate = task.gates.find((g) => g.status === "open");
    if (gate === undefined) {
      throw new OrchestratorError(`Task ${taskId} has no open review gate.`, 409);
    }

    task = this.drive(task, { type: "DECIDE_GATE", gateId: gate.id, decision: "approved" });
    task = this.drive(task, { type: "COMPLETE_TASK" });
    this.emitTaskUpdated(task);

    // ── THE SECURITY WALL ──────────────────────────────────────────────────
    if (!canPush(task)) {
      this.appendMessage("iris", "Approved, but the push gate isn't satisfied — nothing was merged.", task.id);
      return task;
    }
    const worktreePath = requireWorktree(task);
    const branch = this.branchFor(task.id);
    const title = `Bureau: ${truncate(task.goal)}`;
    try {
      await this.d.vcs.push(worktreePath, branch);
      const url = await this.d.vcs.openPr(branch, title, prBody(task.goal));
      await this.d.vcs.mergePr(branch);
      task = this.addArtifacts(task, [
        {
          id: this.d.ids() as ArtifactId,
          kind: "pr_url",
          ref: url,
          producedByStep: task.steps[task.steps.length - 1]!.id,
          createdAt: this.d.clock(),
        },
      ]);
      this.appendMessage("iris", `Merged to main — ${url}. Branch deleted, repo clean.`, task.id);
      await this.d.vcs.removeWorktree({ path: worktreePath, branch }, true);
    } catch (err) {
      this.appendMessage("iris", `The merge failed: ${errMessage(err)}. The branch ${branch} may be pushed — check GitHub.`, task.id);
    }
    return task;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private drive(task: Task, event: TransitionEvent): Task {
    const next = transition(task, event);
    this.save(next);
    return next;
  }

  private save(task: Task): void {
    this.d.store.save(task);
  }

  private requireTask(taskId: string): Task {
    const task = this.d.store.load(taskId as TaskId);
    if (!task) throw new OrchestratorError(`No task found: ${taskId}.`, 404);
    return task;
  }

  private setWorktree(task: Task, worktreePath: string): Task {
    const next: Task = { ...task, worktreePath, updatedAt: this.d.clock() };
    this.save(next);
    return next;
  }

  private addArtifacts(task: Task, artifacts: readonly Artifact[]): Task {
    const next: Task = { ...task, artifacts: [...task.artifacts, ...artifacts], updatedAt: this.d.clock() };
    this.save(next);
    return next;
  }

  private emitTaskUpdated(task: Task): void {
    this.d.events.emit({ type: "task_updated", taskId: task.id, status: task.status });
  }

  private appendMessage(role: Message["role"], content: string, taskId?: string): Message {
    const message: Message = {
      id: this.d.ids(),
      role,
      content,
      ...(taskId !== undefined ? { taskId } : {}),
      createdAt: this.d.clock(),
    };
    this.d.messages.append(message);
    if (role === "iris") {
      this.d.events.emit({ type: "iris_message", messageId: message.id, content });
    }
    return message;
  }

  private branchFor(taskId: string): string {
    return `bureau/task-${taskId}`;
  }
}

function requireWorktree(task: Task): string {
  if (task.worktreePath === undefined) {
    throw new OrchestratorError(`Task ${task.id} has no worktree set.`, 500);
  }
  return task.worktreePath;
}

function truncate(s: string): string {
  return s.length > 72 ? `${s.slice(0, 69)}...` : s;
}

function prBody(goal: string): string {
  return `${goal}\n\n🤖 Opened by Bureau.`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
