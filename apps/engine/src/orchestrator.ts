// Iris — the orchestrator. The CEO and Iris work together: the chat is a
// conversation (no diffs there); Iris proposes tasks; the CEO creates them, and
// holds the decisive powers — START / STOP a task, and the final CONFIRM-MERGE.
//
// THE SECURITY WALL: push()/openPr()/mergePr() run from exactly one place
// (confirmMerge), inside an `if (canPush(task))` branch. canPush lives in
// @bureau/core and is the sole gate. startTask only commits locally — it never
// pushes — so nothing reaches GitHub until the CEO confirms.
//
// Each task belongs to a PROJECT (a GitHub repo). The orchestrator resolves the
// task's project and a VCS port bound to it, so one engine serves many repos.

import { transition, canPush } from "@bureau/core";
import type {
  Task,
  TaskId,
  StepId,
  Step,
  GateId,
  Artifact,
  ArtifactId,
  TransitionEvent,
} from "@bureau/core";
import type { CapabilityRegistry } from "@bureau/capabilities";
import type { Provider } from "@bureau/providers";
import type { Message, TaskProposal, ChatResponse, Project, Conversation, EngineInfo } from "@bureau/contracts";
import { join } from "node:path";

import type { TaskStore, VcsPort, EventSink, MessageLog, ConversationStore } from "./ports.js";
import { ProjectRegistry, toProjectDto, type ProjectConfig } from "./projects.js";
import { OrchestratorError } from "./errors.js";
import { irisRespond } from "./iris.js";

export { OrchestratorError };

export interface OrchestratorDeps {
  readonly store: TaskStore;
  readonly capabilities: CapabilityRegistry;
  readonly provider: Provider;
  readonly projects: ProjectRegistry;
  /** Build a VCS port bound to a given project (clone path, owner/repo, author). */
  readonly vcs: (project: ProjectConfig) => VcsPort;
  readonly events: EventSink;
  readonly messages: MessageLog;
  readonly conversations: ConversationStore;
  readonly ids: () => string;
  readonly clock: () => string;
}

const DEFAULT_CONVERSATION_TITLE = "New chat";

export class Orchestrator {
  /** In-flight background pipelines, keyed by task id (for settle / graceful drain). */
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly d: OrchestratorDeps) {}

  /** The projects the CEO can work on. */
  listProjects(): Project[] {
    return this.d.projects.list().map(toProjectDto);
  }

  /** Engine status for the Settings panel. provider availability is cached — the
   *  CLI strategy probes a subprocess, so we never re-probe per request. */
  private providerAvailable: boolean | undefined;
  engineInfo(): EngineInfo {
    if (this.providerAvailable === undefined) {
      this.providerAvailable = this.d.provider.authStrategy.isAvailable();
    }
    return {
      provider: { name: this.d.provider.name, available: this.providerAvailable },
      projectCount: this.d.projects.list().length,
      inflightTasks: this.running.size,
    };
  }

  /** A conversation turn with Iris, scoped to a project + conversation thread.
   *  Creates a new conversation when none is given. */
  async chat(content: string, projectId?: string, conversationId?: string): Promise<ChatResponse> {
    const project = this.d.projects.resolve(projectId);
    const conversation = this.ensureConversation(conversationId, project);

    this.appendChatMessage(conversation.id, "user", content);
    if (conversation.title === DEFAULT_CONVERSATION_TITLE) {
      this.d.conversations.rename(conversation.id, titleFrom(content), this.d.clock());
    }

    // Iris reads the ACTIVE project's clone (never the engine's own working dir),
    // so she answers about the repo accurately instead of describing unrelated files.
    const cwd = this.d.vcs(project).chatCwd();
    const history = this.d.messages.listByConversation(conversation.id);
    const turn = await irisRespond(this.d.provider, history, project, cwd);

    const reply = this.appendChatMessage(conversation.id, "iris", turn.reply);
    this.d.conversations.touch(conversation.id, this.d.clock());
    return turn.proposal
      ? { reply, conversationId: conversation.id, proposal: turn.proposal }
      : { reply, conversationId: conversation.id };
  }

  /** The CEO's chat threads, most-recent first. */
  listConversations(): Conversation[] {
    return this.d.conversations.list();
  }

  /** Start a fresh, empty conversation. */
  createConversation(projectId?: string): Conversation {
    const project = this.d.projects.resolve(projectId);
    const now = this.d.clock();
    const conversation: Conversation = {
      id: this.d.ids(),
      title: DEFAULT_CONVERSATION_TITLE,
      projectId: project.id,
      createdAt: now,
      updatedAt: now,
    };
    this.d.conversations.create(conversation);
    return conversation;
  }

  deleteConversation(id: string): void {
    this.d.conversations.delete(id);
  }

  /** Messages in a conversation. */
  messagesFor(conversationId: string): Message[] {
    return this.d.messages.listByConversation(conversationId);
  }

  /** Move pre-thread messages into one conversation so the old chat isn't lost. */
  migrateOrphanMessages(): void {
    if (!this.d.messages.list().some((m) => m.conversationId === undefined)) return;
    const now = this.d.clock();
    const conversation: Conversation = {
      id: this.d.ids(),
      title: "Earlier conversation",
      projectId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.d.conversations.create(conversation);
    this.d.messages.adoptOrphans(conversation.id);
  }

  private ensureConversation(conversationId: string | undefined, project: ProjectConfig): Conversation {
    if (conversationId !== undefined) {
      const existing = this.d.conversations.get(conversationId);
      if (existing) return existing;
    }
    return this.createConversation(project.id);
  }

  /** Await the in-flight pipeline for a task (no-op if none). Used by tests and shutdown. */
  async settle(taskId: string): Promise<void> {
    await this.running.get(taskId);
  }

  /** Await every in-flight pipeline (graceful shutdown drain). */
  async settleAll(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  /** On boot, clean up tasks a crash/forced-exit left mid-flight. After a restart
   *  `this.running` is empty, so no pipeline will ever resume a persisted
   *  planning/executing task — it would show a permanent spinner with an orphaned
   *  worktree. Abort each one and tear its worktree down so the panel is honest. */
  async reconcile(): Promise<number> {
    let cleaned = 0;
    for (const task of this.d.store.list()) {
      if (task.status !== "planning" && task.status !== "executing") continue;
      try {
        const aborted = this.drive(task, {
          type: "ABORT_TASK",
          reason: "The engine restarted while this task was running.",
        });
        this.emitTaskUpdated(aborted);
        if (aborted.worktreePath !== undefined) {
          const vcs = this.vcsForTask(aborted);
          if (vcs) await vcs.removeWorktree({ path: aborted.worktreePath, branch: this.branchFor(task.id) }, true).catch(() => {});
        }
        cleaned++;
      } catch {
        /* best-effort per task */
      }
    }
    return cleaned;
  }

  /** Materialize a proposal into a DRAFT task (created, not started) in a project. */
  createTask(proposal: TaskProposal, projectId?: string): Task {
    const project = this.d.projects.resolve(projectId);
    // Refuse a proposal that needs a worker we haven't built yet — so an
    // unsupported step can never become a silently-skipped no-op at run time.
    const unsupported = proposal.steps.find((s) => !this.d.capabilities.has(s.capability));
    if (unsupported) {
      throw new OrchestratorError(
        `Capability "${unsupported.capability}" isn't available yet — only [${this.d.capabilities.list().join(", ")}] can run.`,
        400
      );
    }
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
      projectId: project.id,
      repoOwner: project.owner,
      repoName: project.name,
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

    const promise = this.runPipeline(taskId);
    this.running.set(taskId, promise);
    void promise.finally(() => this.running.delete(taskId));
    return task;
  }

  /** The background pipeline. Race-safe against a concurrent stop: it reloads the
   *  task before every transition and bails the moment it's no longer running. */
  private async runPipeline(taskId: string): Promise<void> {
    const branch = this.branchFor(taskId);
    let currentStepId: StepId | undefined;
    try {
      const project = this.resolveProject(this.requireTask(taskId));
      const vcs = this.d.vcs(project);
      const worktreePath = join(project.worktreesDir, taskId);

      // Persist the worktree path BEFORE creating it: the path is deterministic,
      // but both cleanup paths (stop, failure) gate on the persisted field — so a
      // throw or stop during setup must already have it recorded to clean up.
      this.setWorktree(this.requireTask(taskId), worktreePath);

      await vcs.ensureClone();
      await vcs.setupWorktree(branch, worktreePath);

      let task = this.requireTask(taskId);
      if (task.status !== "planning") {
        // Stopped during setup — clean up the worktree we just made and bail.
        await vcs.removeWorktree({ path: worktreePath, branch }, true).catch(() => {});
        return;
      }
      task = this.drive(task, { type: "PLANNING_DONE" });
      this.emitTaskUpdated(task);

      for (const planned of task.steps) {
        if (this.requireTask(taskId).status !== "executing") return; // stopped between steps
        currentStepId = planned.id;
        task = this.drive(this.requireTask(taskId), { type: "START_STEP", stepId: planned.id });
        this.d.events.emit({ type: "step_started", taskId, stepId: planned.id });

        const step = task.steps.find((s) => s.id === planned.id)!;
        // Fail LOUD on a missing worker — never let a step report "completed"
        // while having produced nothing. (createTask guards this too; this is the
        // run-time backstop.)
        if (!this.d.capabilities.has(step.capability)) {
          throw new Error(`Capability "${step.capability}" is not available yet.`);
        }
        const out = await this.d.capabilities.get(step.capability).execute({
          step,
          worktreePath,
          context: task.goal,
        });
        if (this.requireTask(taskId).status !== "executing") return; // stopped during the step
        if (out.artifacts.length > 0) this.addArtifacts(this.requireTask(taskId), out.artifacts);

        this.drive(this.requireTask(taskId), { type: "COMPLETE_STEP", stepId: planned.id });
        currentStepId = undefined;
        this.d.events.emit({ type: "step_completed", taskId, stepId: planned.id });
      }

      // Capture the diff (incl. new files), then commit it locally on the branch.
      const diff = await vcs.workingDiff(worktreePath);
      if (this.requireTask(taskId).status !== "executing") return; // stopped before commit
      const committed = await vcs.commitAll(worktreePath, `Bureau: ${truncate(this.requireTask(taskId).goal)}`);
      task = this.requireTask(taskId);
      if (task.status !== "executing") return; // stopped during commit
      // Fail loud on a no-op run: if nothing was committed, the workers produced no
      // change — never park an empty task at the review gate as a false "done".
      if (!committed) {
        throw new Error("The pipeline produced no changes — there is nothing to review. The worker may not have edited any files.");
      }
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
    } catch (err) {
      await this.failPipeline(taskId, currentStepId, err);
    }
  }

  /** A pipeline error: mark the running step failed (if any), abort the task, and
   *  clean up. Best-effort, never throws. Awaited as part of runPipeline so the
   *  worktree teardown is covered by settle()/settleAll() (graceful shutdown). */
  private async failPipeline(taskId: string, stepId: StepId | undefined, err: unknown): Promise<void> {
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
      if (task.worktreePath !== undefined) {
        const vcs = this.vcsForTask(task);
        if (vcs) {
          try {
            await vcs.removeWorktree({ path: task.worktreePath, branch: this.branchFor(taskId) }, true);
          } catch (cleanupErr) {
            console.warn(`[engine] could not remove worktree for task ${taskId} (orphaned): ${errMessage(cleanupErr)}`);
          }
        }
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
    if (task.worktreePath !== undefined) {
      const vcs = this.vcsForTask(task);
      if (vcs) {
        const ref = { path: task.worktreePath, branch: this.branchFor(task.id) };
        if (this.running.has(taskId)) {
          // The background pipeline still holds the worktree. Tear it down AFTER it
          // observes the abort and releases the path — single-owner, no race — and
          // don't block the Stop response on it. (settle never rejects.)
          void this.settle(taskId).then(() => vcs.removeWorktree(ref, true).catch(() => {}));
        } else {
          try {
            await vcs.removeWorktree(ref, true);
          } catch {
            /* best-effort: the worktree is orphaned but safe */
          }
        }
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
      console.warn(`[engine] confirmMerge: canPush is false for task ${task.id} — nothing pushed.`);
      return task;
    }
    // Resolve push + PR/merge from ONE project (the task's stable id), so the
    // branch and the PR can never target different repos.
    const project = this.resolveProject(task);
    const vcs = this.d.vcs(project);
    const worktreePath = requireWorktree(task);
    const branch = this.branchFor(task.id);
    const title = `Bureau: ${truncate(task.goal)}`;
    let prUrl: string | undefined;
    try {
      await vcs.push(worktreePath, branch);
      prUrl = await vcs.openPr(branch, title, prBody(task.goal));
      await vcs.mergePr(branch);
      task = this.addArtifacts(task, [
        {
          id: this.d.ids() as ArtifactId,
          kind: "pr_url",
          ref: prUrl,
          producedByStep: task.steps[task.steps.length - 1]!.id,
          createdAt: this.d.clock(),
        },
      ]);
    } catch (err) {
      console.error(
        `[engine] merge failed for task ${task.id}: ${errMessage(err)}${prUrl !== undefined ? ` (PR opened: ${prUrl})` : ""}`
      );
    } finally {
      // Always release the local worktree (the work now lives on the branch / PR).
      await vcs.removeWorktree({ path: worktreePath, branch }, true).catch(() => {});
    }
    return task;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Resolve the project a task belongs to — by its stable, unique id (preferred),
   *  falling back to owner/name only for tasks persisted before projectId existed.
   *  Resolving by id keeps push/PR/merge bound to the same repo even if two
   *  configured projects share an owner/name. */
  private resolveProject(task: Task): ProjectConfig {
    return task.projectId !== undefined
      ? this.d.projects.get(task.projectId)
      : this.d.projects.find(task.repoOwner, task.repoName);
  }

  /** A VCS port bound to a task's project, or null if its project is gone. */
  private vcsForTask(task: Task): VcsPort | null {
    try {
      return this.d.vcs(this.resolveProject(task));
    } catch {
      return null;
    }
  }

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

  private appendChatMessage(conversationId: string, role: Message["role"], content: string): Message {
    const message: Message = {
      id: this.d.ids(),
      conversationId,
      role,
      content,
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

/** A conversation title derived from its first user message. */
function titleFrom(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine === "") return "New chat";
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
}

function prBody(goal: string): string {
  return `${goal}\n\n🤖 Opened by Bureau.`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
