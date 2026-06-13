// Iris — the orchestrator the CEO talks to. Turns a chat message into a Task,
// drives it through the core state machine, runs the edit capability in an
// isolated worktree, parks the diff for human review, and — ONLY after
// core.canPush() === true — pushes and opens the PR.
//
// THE SECURITY WALL: push() and openPr() are called from exactly one place in
// this file, inside an `if (canPush(task))` branch. canPush lives in @bureau/core
// and is the sole gate; this is the only code path that reaches a real push/PR.

import { transition, canPush } from "@bureau/core";
import type {
  Task,
  TaskId,
  StepId,
  GateId,
  Artifact,
  ArtifactId,
  HumanDecision,
  TransitionEvent,
} from "@bureau/core";
import type { CapabilityRegistry } from "@bureau/capabilities";
import type { Message } from "@bureau/contracts";
import { join } from "node:path";

import type { TaskStore, VcsPort, EventSink, MessageLog } from "./ports.js";
import { prUrl } from "./summary.js";

/** Carries an HTTP status so the API layer can map failures cleanly. */
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
  readonly vcs: VcsPort;
  readonly events: EventSink;
  readonly messages: MessageLog;
  readonly config: OrchestratorConfig;
  readonly ids: () => string;
  readonly clock: () => string;
}

export class Orchestrator {
  constructor(private readonly d: OrchestratorDeps) {}

  /** Chat → a Task driven all the way to "awaiting human review of the diff". */
  async handleMessage(content: string): Promise<{ message: Message; task: Task }> {
    this.appendMessage("user", content);

    const taskId = this.d.ids();
    const stepId = this.d.ids();
    const gateId = this.d.ids();
    const now = this.d.clock();

    let task: Task = {
      id: taskId as TaskId,
      goal: content,
      repoOwner: this.d.config.repoOwner,
      repoName: this.d.config.repoName,
      status: "created",
      steps: [
        {
          id: stepId as StepId,
          capability: "edit",
          description: content,
          acceptanceCriteria: [],
          status: "pending",
          gateAfter: gateId as GateId,
          artifactIds: [],
        },
      ],
      // The single human gate is a pr_approval gate — that is what canPush()
      // requires to authorize the push. The human reviews the diff and, by
      // approving, authorizes the PR.
      gates: [{ id: gateId as GateId, kind: "pr_approval", status: "pending" }],
      artifacts: [],
      decisionLog: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(task);

    task = this.drive(task, { type: "START_PLANNING" });
    task = this.drive(task, { type: "PLANNING_DONE" });

    // Isolated worktree for this task.
    await this.d.vcs.ensureClone();
    const branch = this.branchFor(taskId);
    const worktreePath = join(this.d.config.worktreesDir, taskId);
    await this.d.vcs.setupWorktree(branch, worktreePath);
    task = this.setWorktree(task, worktreePath);

    // Run the edit capability.
    task = this.drive(task, { type: "START_STEP", stepId: stepId as StepId });
    this.d.events.emit({ type: "step_started", taskId, stepId });

    const capability = this.d.capabilities.get("edit");
    const output = await capability.execute({
      step: task.steps[0]!,
      worktreePath,
      context: content,
    });

    const diff = await this.d.vcs.workingDiff(worktreePath);
    const diffArtifact: Artifact = {
      id: this.d.ids() as ArtifactId,
      kind: "diff",
      ref: diff,
      producedByStep: stepId as StepId,
      createdAt: this.d.clock(),
    };
    task = this.addArtifacts(task, [...output.artifacts, diffArtifact]);

    task = this.drive(task, { type: "COMPLETE_STEP", stepId: stepId as StepId });
    this.d.events.emit({ type: "step_completed", taskId, stepId });

    task = this.drive(task, { type: "OPEN_GATE", gateId: gateId as GateId });
    this.d.events.emit({ type: "gate_opened", taskId, gateId, gateKind: "pr_approval" });
    this.emitTaskUpdated(task);

    const message = this.appendMessage(
      "iris",
      `I prepared the change for "${truncate(content)}". Review the diff and approve to open the PR.`,
      taskId
    );
    return { message, task };
  }

  /** Human decision on a gate. Approval is the ONLY path to a real push/PR. */
  async decideGate(gateId: string, decision: HumanDecision, notes?: string): Promise<Task> {
    const found = this.findTaskByGate(gateId);
    if (!found) throw new OrchestratorError(`No task found for gate ${gateId}.`, 404);

    const gate = found.gates.find((g) => g.id === gateId);
    if (gate === undefined || gate.status !== "open") {
      // A re-decision / double-submit — a benign conflict, not a server crash.
      throw new OrchestratorError(
        `Gate ${gateId} is not open (already ${gate?.status ?? "absent"}).`,
        409
      );
    }

    const event: TransitionEvent = {
      type: "DECIDE_GATE",
      gateId: gateId as GateId,
      decision,
      ...(notes !== undefined ? { notes } : {}),
    };
    let task = this.drive(found, event);
    this.emitTaskUpdated(task);

    if (decision !== "approved") {
      this.appendMessage(
        "iris",
        decision === "rejected"
          ? "You rejected the diff — nothing was pushed."
          : "You requested changes — nothing was pushed.",
        task.id
      );
      return task;
    }

    // Approved → finish the task, then let the wall decide.
    task = this.drive(task, { type: "COMPLETE_TASK" });
    this.emitTaskUpdated(task);

    // ── THE SECURITY WALL ──────────────────────────────────────────────────
    if (!canPush(task)) {
      this.appendMessage("iris", "Approved, but the push gate isn't satisfied — nothing was pushed.", task.id);
      return task;
    }
    // canPush() === true: the one and only path to push/openPr.
    const worktreePath = requireWorktree(task);
    const committed = await this.d.vcs.commitAll(worktreePath, `Bureau: ${truncate(task.goal)}`);
    if (!committed) {
      this.appendMessage("iris", "Approved, but the edit produced no changes — nothing to push.", task.id);
      return task;
    }
    return this.publish(task, worktreePath);
  }

  /**
   * Retry opening the PR for a task whose commit was pushed but whose PR failed
   * to open (partial failure recovery). Idempotent: a no-op if the PR exists,
   * and still gated by canPush().
   */
  async retryPr(taskId: string): Promise<Task> {
    const task = this.d.store.load(taskId as TaskId);
    if (!task) throw new OrchestratorError(`No task found: ${taskId}.`, 404);
    if (prUrl(task) !== null) return task; // already opened — nothing to do
    if (!canPush(task)) {
      throw new OrchestratorError(`Task ${taskId} is not in a pushable state.`, 409);
    }
    return this.publish(task, requireWorktree(task));
  }

  /**
   * Push the branch and open the PR. Reached ONLY after canPush()===true. If the
   * PR step fails, the (already-pushed) branch is recorded in an iris message and
   * the task is returned WITHOUT throwing, so the slice stays recoverable via
   * retryPr() — git push is a fast-forward no-op on retry, so no double push.
   */
  private async publish(task: Task, worktreePath: string): Promise<Task> {
    const branch = this.branchFor(task.id);
    const title = `Bureau: ${truncate(task.goal)}`;
    try {
      await this.d.vcs.push(worktreePath, branch);
      const url = await this.d.vcs.openPr(branch, title, prBody(task.goal));
      const withPr = this.addArtifacts(task, [
        {
          id: this.d.ids() as ArtifactId,
          kind: "pr_url",
          ref: url,
          producedByStep: task.steps[0]!.id,
          createdAt: this.d.clock(),
        },
      ]);
      this.appendMessage("iris", `Done — opened PR: ${url}`, task.id);
      return withPr;
    } catch (err) {
      this.appendMessage(
        "iris",
        `Pushed branch ${branch}, but opening the PR failed: ${errMessage(err)}. You can retry.`,
        task.id
      );
      return task;
    }
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

  private setWorktree(task: Task, worktreePath: string): Task {
    const next: Task = { ...task, worktreePath, updatedAt: this.d.clock() };
    this.save(next);
    return next;
  }

  private addArtifacts(task: Task, artifacts: readonly Artifact[]): Task {
    const next: Task = {
      ...task,
      artifacts: [...task.artifacts, ...artifacts],
      updatedAt: this.d.clock(),
    };
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

  private findTaskByGate(gateId: string): Task | null {
    return this.d.store.list().find((t) => t.gates.some((g) => g.id === gateId)) ?? null;
  }
}

function requireWorktree(task: Task): string {
  if (task.worktreePath === undefined) {
    throw new OrchestratorError(`Task ${task.id} has no worktree set.`);
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
