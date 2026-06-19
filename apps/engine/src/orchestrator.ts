// Iris — the orchestrator. The CEO and Iris work together: the chat is a
// conversation (no diffs there); Iris proposes tasks; the CEO creates them, and
// holds the decisive powers — START / STOP a task, and the final CONFIRM-MERGE.
//
// THE SECURITY WALL: push()/openPr()/mergePr() run ONLY behind an `if (canPush(task))`
// gate, from two paths — landBranch (push + PR [+ merge], via confirmMerge or
// openPrForReview) and mergeOpenPr (the deferred squash-merge of an already-open PR).
// canPush lives in @bureau/core and is the sole gate. startTask only commits locally —
// it never pushes — so nothing reaches GitHub until the CEO confirms.
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
  HumanDecision,
} from "@bureau/core";
import type { CapabilityRegistry } from "@bureau/capabilities";
import type { Provider } from "@bureau/providers";
import type { Message, TaskProposal, ChatResponse, Project, CreateProjectRequest, Conversation, EngineInfo, Hub, Note, NoteSummary, UsageSummary, CostEstimate, Notification, NotificationKind, GitInfo, Attachment, GitOpRequest, GitOpResult, GitTree, GitFileContent, GithubAccount, PullRequest, Issue, TreeCommits, CommitDetail, FileList, FileHistory } from "@bureau/contracts";
import { DESTRUCTIVE_GIT_OPS } from "@bureau/contracts";
import type { ProjectRepo } from "@bureau/db";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";

import type { TaskStore, VcsPort, EventSink, MessageLog, ConversationStore, MemoryPort, UsagePort, NotificationStore, RepoView, GitAdminOp } from "./ports.js";
import { ProjectRegistry, toProjectDto, buildProjectConfig, type ProjectConfig } from "./projects.js";
import { defaultModelPolicy, resolveModel, isKnownModel, MODEL_SCOPES, type ModelPolicy } from "./models.js";
import { OrchestratorError } from "./errors.js";
import { irisRespond } from "./iris.js";
import { buildHub } from "./hub.js";
import { journalPath, journalMarkdown, journalRepo, notePath } from "./memory.js";
import { estimateTaskCost, type ScopeAverage } from "./estimate.js";
import { costUsd } from "./usage.js";
import { ASSIGNEE, prOpen, prUrl, isMerged } from "./summary.js";

export { OrchestratorError };

// Per-step wall-clock backstop. Set ABOVE each worker's OWN self-timeout AND its retry
// budget so a normal slow-but-retrying run never trips it — this only catches a hung
// promise that never settles (e.g. a wedged stream). A read-only CLI step retries ≤2×,
// each capped at the 240s CLI self-kill → ≤3 × 240s ≈ 12min worst case, so 15min headroom.
const STEP_TIMEOUT_MS = 900_000; // 15 min — > 3 × the 240s CLI cap (retries:2)
const TEST_STEP_TIMEOUT_MS = 660_000; // 11 min — > the test runner's 600s self-timeout (no retries)

export interface OrchestratorDeps {
  readonly store: TaskStore;
  readonly capabilities: CapabilityRegistry;
  readonly provider: Provider;
  readonly projects: ProjectRegistry;
  /** Persisted project store (DB) — projects survive restarts; the registry is seeded from it. */
  readonly projectRepo: ProjectRepo;
  /** Root dir under which each project's clone + worktrees live (paths derived from id). */
  readonly reposRoot: string;
  /** Build a VCS port bound to a given project (clone path, owner/repo, author). */
  readonly vcs: (project: ProjectConfig) => VcsPort;
  readonly events: EventSink;
  readonly messages: MessageLog;
  readonly conversations: ConversationStore;
  readonly memory: MemoryPort;
  readonly usage: UsagePort;
  readonly notifications: NotificationStore;
  /** Per-scope model policy (iris + each worker). Defaults to all-Opus when omitted. */
  readonly models?: ModelPolicy;
  /** Per-task USD spend cap — a running task aborts before its next step once it crosses
   *  this. 0 / omitted = no cap (the historical default). */
  readonly budgetUsd?: number;
  readonly ids: () => string;
  readonly clock: () => string;
}

const DEFAULT_CONVERSATION_TITLE = "New chat";

export class Orchestrator {
  /** In-flight background pipelines, keyed by task id (for settle / graceful drain). */
  private readonly running = new Map<string, Promise<void>>();
  /** Tasks with an in-flight deferred merge — serializes mergeOpenPr against a double-click. */
  private readonly merging = new Set<string>();
  /** Which model each scope runs on — mutable (the CEO can change it in Settings). */
  private readonly modelPolicy: ModelPolicy;
  /** Per-task USD cap — mutable (the CEO sets it in Settings). 0 = no cap. */
  private budgetUsd: number;

  constructor(private readonly d: OrchestratorDeps) {
    this.modelPolicy = { ...(d.models ?? defaultModelPolicy()) };
    this.budgetUsd = Math.max(0, d.budgetUsd ?? 0);
  }

  /** Set the per-task USD budget cap (0 = no cap). Returns the clamped value in effect. */
  setBudget(usd: number): number {
    this.budgetUsd = Math.max(0, Number.isFinite(usd) ? usd : 0);
    return this.budgetUsd;
  }

  /** The projects the CEO can work on. */
  listProjects(): Project[] {
    return this.d.projects.list().map(toProjectDto);
  }

  /** Add a project the CEO supplied by URL: validate → persist → clone → register → notify.
   *  Eager clone (with rollback) so a bad URL / unreachable repo fails the request loudly. */
  async addProject(req: CreateProjectRequest): Promise<Project> {
    // Validate the URL + derive owner/name/id + safe on-disk paths (throws on a bad URL).
    const config = buildProjectConfig(this.d.reposRoot, {
      url: req.url,
      baseBranch: req.baseBranch,
      testCommand: req.testCommand,
    });
    if (this.d.projects.list().some((p) => p.id === config.id)) {
      throw new OrchestratorError(`A project for ${config.owner}/${config.name} already exists`, 409);
    }
    // Persist first, then clone eagerly; roll back the row + any partial clone on failure.
    this.d.projectRepo.upsert({
      id: config.id,
      owner: config.owner,
      name: config.name,
      url: config.url,
      baseBranch: config.baseBranch,
      testCommand: config.testCommand ? [...config.testCommand] : null,
      createdAt: this.d.clock(),
    });
    try {
      await this.d.vcs(config).ensureClone();
    } catch (err) {
      this.d.projectRepo.delete(config.id);
      await rm(join(this.d.reposRoot, config.id), { recursive: true, force: true }).catch(() => {});
      throw new OrchestratorError(`Couldn't clone ${config.owner}/${config.name}: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    this.d.projects.add(config); // mutate the one shared registry in place → every consumer sees it
    this.d.events.emit({ type: "projects_changed" });
    return toProjectDto(config);
  }

  /** Remove a project. Refuses (409) while any non-terminal task still references it
   *  (unless forced); then drops it from the registry + DB and deletes its clone on disk. */
  async removeProject(id: string, opts?: { force?: boolean }): Promise<void> {
    const project = this.d.projects.get(id); // 404 if unknown
    const live = this.d.store
      .list()
      .filter(
        (t) =>
          t.status !== "completed" &&
          t.status !== "aborted" &&
          (t.projectId === id || (t.repoOwner === project.owner && t.repoName === project.name))
      );
    if (live.length > 0 && opts?.force !== true) {
      throw new OrchestratorError(`${live.length} task(s) still reference this project — finish or stop them first`, 409);
    }
    this.d.projects.remove(id); // may empty the registry → panel falls back to onboarding
    this.d.projectRepo.delete(id);
    // Delete the on-disk clone (clean/lean — no orphaned dirs). Path-guarded vs traversal.
    const dir = join(this.d.reposRoot, id);
    if (resolve(dir).startsWith(resolve(this.d.reposRoot) + sep)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    this.d.events.emit({ type: "projects_changed" });
  }

  /** The Agent-Activity Hub: live capability-worker status, a cross-task activity
   *  feed, and the "waiting on you" review queue — built from the live task set. */
  hub(): Hub {
    return buildHub(this.d.store.list(), (k) => this.d.capabilities.has(k), 40);
  }

  /** Forecast a proposed pipeline's token + USD cost before the CEO creates the task —
   *  per step, from that scope's historical average when there's enough data, else a default. */
  estimateCost(capabilities: readonly string[]): CostEstimate {
    const averages = new Map<string, ScopeAverage>();
    for (const s of this.d.usage.summary(null).byScope) {
      averages.set(s.scope, { inputTokens: s.inputTokens, outputTokens: s.outputTokens, events: s.events });
    }
    return estimateTaskCost(capabilities, this.modelPolicy, averages);
  }

  private terminalCtx: ((projectId?: string) => string) | null = null;

  /** Wire the embedded terminal so Iris can "see" (read-only) the recent output of
   *  commands the CEO ran in it — closing the propose→run→observe loop. */
  attachTerminal(recentOutput: (projectId?: string) => string): void {
    this.terminalCtx = recentOutput;
  }

  /** Read-only Git console for a project: current branch, recent commits, branches.
   *  Refreshes the clone from origin FIRST so the console shows the LIVE repo. */
  async gitInfo(projectId?: string): Promise<GitInfo> {
    const project = this.d.projects.resolve(projectId);
    const port = this.d.vcs(project);
    await port.syncClone().catch(() => {}); // live, best-effort
    const view = await port.repoInfo(20);
    return {
      projectId: project.id,
      owner: project.owner,
      name: project.name,
      baseBranch: project.baseBranch,
      branch: view.branch,
      cloned: view.cloned,
      commits: view.commits.map((c) => ({ ...c })),
      // Show the repo's real branches — hide Bureau's internal task worktree
      // branches (bureau/task-*), which live in the "Agent branches" section.
      branches: view.branches.filter((b) => !b.startsWith("bureau/")),
    };
  }

  /** Read-only codebase browser: one directory level at `ref` (defaults to base branch). */
  async gitTree(projectId: string | undefined, ref: string | undefined, dir: string | undefined): Promise<GitTree> {
    const project = this.d.projects.resolve(projectId);
    const r = ref && ref.trim() !== "" ? ref : project.baseBranch;
    const path = dir ?? "";
    const vcs = this.d.vcs(project);
    // A freshly-created repo with no commits has no resolvable tree — report it as empty
    // (the panel shows a "no commits yet" state) instead of erroring on `ls-tree`.
    const empty = await vcs.isEmpty();
    return { ref: r, path, empty, entries: empty ? [] : await vcs.listTree(r, path) };
  }

  /** Read-only codebase browser: a file's content at `ref` (defaults to base branch). */
  async gitShow(projectId: string | undefined, ref: string | undefined, path: string): Promise<GitFileContent> {
    const project = this.d.projects.resolve(projectId);
    const r = ref && ref.trim() !== "" ? ref : project.baseBranch;
    const { content, truncated } = await this.d.vcs(project).showFile(r, path);
    return { ref: r, path, content, truncated };
  }

  /** The GitHub account `gh` is signed in as (read-only) — for the Settings card. */
  async githubAccount(): Promise<GithubAccount> {
    try {
      const project = this.d.projects.resolve(undefined);
      const acct = await this.d.vcs(project).githubAccount();
      return acct ? { connected: true, login: acct.login, name: acct.name } : { connected: false };
    } catch {
      return { connected: false };
    }
  }

  /** Read-only: the active project's pull requests (via gh). [] if unavailable. */
  prList(projectId?: string): Promise<PullRequest[]> {
    return this.d.vcs(this.d.projects.resolve(projectId)).prList();
  }

  /** Read-only: the active project's issues (via gh). [] if unavailable. */
  issueList(projectId?: string): Promise<Issue[]> {
    return this.d.vcs(this.d.projects.resolve(projectId)).issueList();
  }

  /** Read-only: the latest commit per entry in a directory at `ref` (the code browser's
   *  "latest commit" column). Loaded after the tree so the listing renders instantly. */
  async gitTreeCommits(projectId: string | undefined, ref: string | undefined, dir: string | undefined): Promise<TreeCommits> {
    const project = this.d.projects.resolve(projectId);
    const r = ref && ref.trim() !== "" ? ref : project.baseBranch;
    const path = dir ?? "";
    return { ref: r, path, commits: await this.d.vcs(project).treeCommits(r, path) };
  }

  /** Read-only: one commit's metadata, file stats, and patch (capped) — the diff viewer. */
  async gitCommit(projectId: string | undefined, ref: string | undefined): Promise<CommitDetail> {
    if (!ref || ref.trim() === "") throw new OrchestratorError("A commit ref is required.", 400);
    const project = this.d.projects.resolve(projectId);
    const detail = await this.d.vcs(project).commitDetail(ref);
    if (!detail) throw new OrchestratorError(`Commit "${ref}" was not found.`, 404);
    return detail;
  }

  /** Read-only: every file path in the repo at `ref` — the "go to file" finder. */
  async gitFiles(projectId: string | undefined, ref: string | undefined): Promise<FileList> {
    const project = this.d.projects.resolve(projectId);
    const r = ref && ref.trim() !== "" ? ref : project.baseBranch;
    const { paths, truncated } = await this.d.vcs(project).listFiles(r);
    return { ref: r, paths, truncated };
  }

  /** Read-only: commits that touched a file, newest first (file history). */
  async gitFileHistory(projectId: string | undefined, ref: string | undefined, path: string): Promise<FileHistory> {
    const project = this.d.projects.resolve(projectId);
    const r = ref && ref.trim() !== "" ? ref : project.baseBranch;
    return { ref: r, path, commits: (await this.d.vcs(project).fileHistory(r, path)).map((c) => ({ ...c })) };
  }

  /** Delete leftover bureau/task-* branches for the active project — keeping the
   *  branches of tasks that are still in flight (a parked/running task still needs
   *  its branch). CEO-initiated branch hygiene; only ever touches bureau/task-*. */
  async cleanupTaskBranches(projectId?: string): Promise<{ deleted: string[]; kept: number }> {
    const project = this.d.projects.resolve(projectId);
    const port = this.d.vcs(project);
    await port.syncClone().catch(() => {}); // fresh view of branches
    // A task that hasn't reached a terminal state still owns its branch.
    const keep = this.d.store
      .list()
      .filter((t) => t.status !== "completed" && t.status !== "aborted")
      .map((t) => this.branchFor(t.id));
    const deleted = await port.pruneTaskBranches(keep);
    return { deleted, kept: keep.length };
  }

  /** Delete ONE leftover bureau/task-* branch for the active project. Refuses a
   *  branch still owned by an in-flight task (it needs it); the vcs layer refuses
   *  anything outside the bureau/task-* namespace. */
  async deleteBranch(branch: string, projectId?: string): Promise<{ deleted: boolean }> {
    if (!/^bureau\/task-[A-Za-z0-9._-]+$/.test(branch)) {
      throw new OrchestratorError(`Refusing to delete "${branch}": only Bureau task branches are deletable.`, 400);
    }
    const inFlight = this.d.store
      .list()
      .filter((t) => t.status !== "completed" && t.status !== "aborted")
      .map((t) => this.branchFor(t.id));
    if (inFlight.includes(branch)) {
      throw new OrchestratorError(`Branch ${branch} belongs to a task that's still in flight — stop or finish it first.`, 409);
    }
    const project = this.d.projects.resolve(projectId);
    const port = this.d.vcs(project);
    return { deleted: await port.deleteBranch(branch) };
  }

  /** Run a CEO-AUTHORIZED git history/admin operation on the project's clone (squash,
   *  force-push, reset, branch & tag admin). DESTRUCTIVE ops (squash/force-push/reset/
   *  delete) require `confirmation` to EXACTLY match the target branch (case-sensitive,
   *  enforced here). Execution is argv-only (no shell). The code-merge security wall
   *  (canPush) is untouched — git-admin has its OWN explicit human gate (type-to-confirm). */
  async runGitOp(req: GitOpRequest): Promise<GitOpResult> {
    const project = this.d.projects.resolve(req.projectId);
    const { op, confirmTarget } = resolveGitOp(req);
    if (DESTRUCTIVE_GIT_OPS.has(req.kind) && req.confirmation !== confirmTarget) {
      throw new OrchestratorError(`This is a destructive operation — type "${confirmTarget}" exactly to confirm.`, 400);
    }
    try {
      await this.d.vcs(project).gitAdmin(op);
    } catch (e) {
      throw new OrchestratorError(`Git operation failed: ${errMessage(e)}`, 422);
    }
    return { ok: true, message: gitOpDone(op) };
  }

  // ── Notifications ─────────────────────────────────────────────────────────────

  /** The CEO's notifications, newest first. */
  listNotifications(): Notification[] {
    return this.d.notifications.list();
  }

  unreadNotifications(): number {
    return this.d.notifications.unreadCount();
  }

  markNotificationRead(id: string): void {
    this.d.notifications.markRead(id, this.d.clock());
  }

  markAllNotificationsRead(): void {
    this.d.notifications.markAllRead(this.d.clock());
  }

  /** Persist a CEO notification and push it over the WS (best-effort — a
   *  notification must never break the lifecycle action that triggered it). */
  private notify(kind: NotificationKind, taskId: string | null, subject: string, body: string): void {
    try {
      const n: Notification = { id: this.d.ids(), kind, taskId, subject, body, createdAt: this.d.clock(), readAt: null };
      this.d.notifications.create(n);
      this.d.events.emit({ type: "notification", notificationId: n.id, kind: n.kind, subject: n.subject });
    } catch (err) {
      console.warn(`[engine] could not record notification: ${errMessage(err)}`);
    }
  }

  // ── Usage & Cost ────────────────────────────────────────────────────────────

  /** Aggregated token spend + cost. `days` limits the look-back window (UTC); omit for all-time. */
  usageSummary(days?: number): UsageSummary {
    let sinceDay: string | null = null;
    if (days !== undefined && days > 0) {
      const since = new Date(this.d.clock());
      since.setUTCDate(since.getUTCDate() - days);
      sinceDay = since.toISOString().slice(0, 10);
    }
    return this.d.usage.summary(sinceDay);
  }

  /** A test step that completed with a ✗ verdict → an advisory red flag in the
   *  inbox, so the CEO sees it before opening the task. NEVER blocks (the test
   *  result is advisory; the human still decides at the gate). Best-effort. */
  private notifyTestFailure(taskId: string, capability: string, summary: string): void {
    // ✗ (failed/timed out) or ⚠ (couldn't run) — both mean "tests didn't pass".
    if (capability !== "test" || !(summary.startsWith("✗") || summary.startsWith("⚠"))) return;
    const goal = (() => {
      try {
        return truncate(this.requireTask(taskId).goal);
      } catch {
        return taskId;
      }
    })();
    this.notify("failed", taskId, "Tests failed", `“${goal}” — ${summary.split("\n")[0]} Review carefully before merging.`);
  }

  /** Record a provider round-trip's spend. No-ops on a zero-token usage (or none). */
  private recordUsage(scope: string, taskId: string | null, usage?: { inputTokens: number; outputTokens: number; model: string }): void {
    if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) return;
    const now = this.d.clock();
    this.d.usage.record({
      id: this.d.ids(),
      day: now.slice(0, 10),
      scope,
      taskId,
      model: usage.model || "unknown",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      createdAt: now,
    });
  }

  // ── System Memory ───────────────────────────────────────────────────────────

  /** Vault notes (task journals + CEO notes), newest first; filtered when a query is given. */
  listNotes(query?: string): Promise<NoteSummary[]> {
    return this.d.memory.list(query);
  }

  /** One vault note (with body), or null. */
  getNote(path: string): Promise<Note | null> {
    return this.d.memory.get(path);
  }

  /** Create/update a free-form CEO note. Refuses (409) to overwrite a DIFFERENT
   *  existing note — when the title slugs to a path that already exists and isn't the
   *  note being edited (`expectedPath`) — so distinct titles never silently clobber. */
  async saveNote(title: string, body: string, expectedPath?: string): Promise<Note> {
    const path = notePath(title);
    if (path !== expectedPath && (await this.d.memory.get(path)) !== null) {
      throw new OrchestratorError(`A note titled “${title}” already exists — choose a different title, or open that note to edit it.`, 409);
    }
    return this.d.memory.saveNote(title, body);
  }

  /** Delete a vault note by path. */
  deleteNote(path: string): Promise<void> {
    return this.d.memory.delete(path);
  }

  /** Auto-write a finished task's journal to the vault. Best-effort — a vault
   *  write must never fail a merge/stop/abort. */
  private async journalTask(task: Task): Promise<void> {
    try {
      await this.d.memory.writeJournal(journalPath(task), journalMarkdown(task, this.d.clock()));
    } catch (err) {
      console.warn(`[engine] could not journal task ${task.id}: ${errMessage(err)}`);
    }
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
      models: { ...this.modelPolicy },
      budgetUsd: this.budgetUsd,
    };
  }

  /** Set the model for one or more scopes (Settings). Validates each id against the
   *  known list (so an unpriced/unsupported model can't be selected) and ignores any
   *  unknown scope. In-memory for the session — env (BUREAU_MODEL_*) is the durable set. */
  setModels(models: Record<string, string>): Record<string, string> {
    // Validate the WHOLE batch before mutating anything — all-or-nothing, so a bad id in
    // a multi-scope write never leaves some scopes silently changed behind a 422.
    for (const model of Object.values(models)) {
      if (!isKnownModel(model)) {
        throw new OrchestratorError(`Unknown model "${model}" — choose a supported model.`, 422);
      }
    }
    for (const [scope, model] of Object.entries(models)) {
      if ((MODEL_SCOPES as readonly string[]).includes(scope)) this.modelPolicy[scope] = model;
    }
    return { ...this.modelPolicy };
  }

  /** A conversation turn with Iris, scoped to a project + conversation thread.
   *  Creates a new conversation when none is given. */
  async chat(content: string, projectId?: string, conversationId?: string, attachments?: readonly Attachment[]): Promise<ChatResponse> {
    const project = this.d.projects.resolve(projectId);
    const conversation = this.ensureConversation(conversationId, project);

    // Inline text attachments into the message; save images so Iris can Read (view) them.
    const { messageContent, images, imagesDir } = await this.prepareAttachments(content, attachments, conversation.id);
    this.appendChatMessage(conversation.id, "user", messageContent);
    if (conversation.title === DEFAULT_CONVERSATION_TITLE) {
      const seed = content.trim() || attachments?.[0]?.name || "Attachments";
      this.d.conversations.rename(conversation.id, titleFrom(seed), this.d.clock());
    }

    // Iris reads the ACTIVE project's clone (never the engine's own working dir).
    // Refresh it to the LIVE main FIRST so she describes the current repo, not a
    // stale snapshot from clone time. Best-effort — a fetch hiccup never fails chat.
    const port = this.d.vcs(project);
    await port.syncClone().catch(() => {});
    const cwd = port.chatCwd();
    // Hand Iris the repo's git state (branches + recent commits) — she has no shell,
    // so without this she can't answer about branches/history.
    const repo = await port.repoInfo(8).catch(() => null);
    const history = this.d.messages.listByConversation(conversation.id);
    const irisProject = { owner: project.owner, name: project.name, baseBranch: project.baseBranch, hasTests: project.testCommand !== undefined };
    // Fold the repo's git state, recent Bureau-terminal output, AND the CEO's pinned
    // System Memory notes into Iris's read-only context — so she can answer about
    // branches/history, reference terminal results, and actually KNOW the saved notes.
    const termOut = this.terminalCtx?.(project.id)?.trim();
    const memory = await this.buildMemoryContext(irisProject);
    const context =
      [
        repo ? buildRepoContext(repo) : "",
        termOut ? `Recent Bureau-terminal output (the CEO ran these — read-only, for your reference):\n${termOut}` : "",
        memory,
      ]
        .filter((s) => s !== "")
        .join("\n\n") || undefined;
    let turn;
    try {
      turn = await irisRespond(
        this.d.provider, history, irisProject, cwd, context, images, resolveModel(this.modelPolicy, "iris"),
        (summary) => this.d.events.emit({ type: "iris_activity", summary }),
        this.memoryReadDirs()
      );
    } finally {
      // The agent has Read the images during the turn — drop the temp dir so image
      // attachments don't accumulate on disk over the daemon's life.
      if (imagesDir) await rm(imagesDir, { recursive: true, force: true }).catch(() => {});
    }

    const reply = this.appendChatMessage(conversation.id, "iris", turn.reply);
    this.recordUsage("iris", null, turn.usage);
    this.d.conversations.touch(conversation.id, this.d.clock());
    const base = { reply, conversationId: conversation.id };
    if (turn.proposal) return { ...base, proposal: turn.proposal };
    if (turn.gitOp) return { ...base, gitOp: turn.gitOp };
    return base;
  }

  /** A STATELESS turn with Iris — used by the embedded terminal dock. Persists
   *  NOTHING (no conversation, no messages), so it never appears in the Assistant;
   *  the caller supplies prior turns inline as `history`. Iris still sees the repo
   *  state + recent terminal output, and may still return a proposal (which the CEO
   *  creates as a normal, gated task). */
  async chatEphemeral(
    content: string,
    projectId: string | undefined,
    history: readonly { role: "user" | "iris"; content: string }[],
    attachments?: readonly Attachment[]
  ): Promise<ChatResponse> {
    const project = this.d.projects.resolve(projectId);
    // No conversation to key on — use a throwaway id for the per-turn image dir.
    const turnId = this.d.ids();
    const { messageContent, images, imagesDir } = await this.prepareAttachments(content, attachments, turnId);

    const port = this.d.vcs(project);
    await port.syncClone().catch(() => {});
    const cwd = port.chatCwd();
    const repo = await port.repoInfo(8).catch(() => null);
    const termOut = this.terminalCtx?.(project.id)?.trim();
    const irisProject = { owner: project.owner, name: project.name, baseBranch: project.baseBranch, hasTests: project.testCommand !== undefined };
    const memory = await this.buildMemoryContext(irisProject);
    const context =
      [
        repo ? buildRepoContext(repo) : "",
        termOut ? `Recent Bureau-terminal output (the CEO ran these — read-only, for your reference):\n${termOut}` : "",
        memory,
      ]
        .filter((s) => s !== "")
        .join("\n\n") || undefined;

    // Build the turn from the inline history + this message — nothing from the DB.
    const msgs: Message[] = [
      ...history.map((h) => ({ id: this.d.ids(), role: h.role, content: h.content, createdAt: "" }) satisfies Message),
      { id: this.d.ids(), role: "user", content: messageContent, createdAt: "" } satisfies Message,
    ];

    let turn;
    try {
      turn = await irisRespond(
        this.d.provider, msgs, irisProject, cwd, context, images, resolveModel(this.modelPolicy, "iris"),
        (summary) => this.d.events.emit({ type: "iris_activity", summary }),
        this.memoryReadDirs()
      );
    } finally {
      if (imagesDir) await rm(imagesDir, { recursive: true, force: true }).catch(() => {});
    }
    this.recordUsage("iris", null, turn.usage);
    const reply: Message = { id: this.d.ids(), role: "iris", content: turn.reply, createdAt: this.d.clock() };
    const base = { reply, conversationId: "" };
    if (turn.proposal) return { ...base, proposal: turn.proposal };
    if (turn.gitOp) return { ...base, gitOp: turn.gitOp };
    return base;
  }

  /** The CEO's pinned System Memory notes (kind=note, not auto journals) folded into
   *  Iris's read-only chat context — so she actually KNOWS what's in the vault instead
   *  of claiming her memory is empty. Bounded so a big vault can't blow the prompt. */
  private async buildMemoryContext(project: { owner: string; name: string }): Promise<string> {
    try {
      const all = await this.d.memory.list();
      const sections: string[] = [];

      // Free-form CEO notes — injected IN FULL (curated, authoritative, few + small).
      const notes = all.filter((n) => n.kind === "note").slice(0, 12);
      if (notes.length > 0) {
        const CAP = 16_000;
        const parts: string[] = [];
        let total = 0;
        for (const n of notes) {
          const full = await this.d.memory.get(n.path);
          const body = (full?.body ?? n.excerpt).trim();
          const block = `### ${n.title}\n${body}`;
          if (total + block.length > CAP) break;
          parts.push(block);
          total += block.length;
        }
        if (parts.length > 0) {
          sections.push(
            `Your saved System Memory notes (durable facts the CEO pinned for you — treat them as authoritative; you DO have these). When the CEO asks ABOUT a note, report ONLY what that note literally says below — do NOT attribute any of your other behavioral or system instructions (e.g. terminal/shell rules) to a note, and never invent note content:\n\n${parts.join("\n\n")}`
          );
        }
      }

      // Task journals — an INDEX, not the full bodies (they're many + large). Each journal
      // is a finished task's record: its plan, RESEARCH FINDINGS (under "## Reports"),
      // review, and outcome. Iris opens the relevant one with her Read tool (the vault is in
      // her read dirs), so she answers about past research/plans from the real content — the
      // whole point: a research task's findings reach the chat without the CEO copy-pasting.
      // The vault is GLOBAL across repos, so scope the index to THIS project (a journal carries
      // its repo in the body) — otherwise other projects' task titles leak into this chat.
      const root = this.d.memory.root();
      const repoKey = `${project.owner}/${project.name}`;
      const candidates = all.filter((n) => n.kind === "journal").slice(0, 24); // bound the scan
      const lines: string[] = [];
      for (const j of candidates) {
        if (lines.length >= 12) break;
        const full = await this.d.memory.get(j.path);
        const repo = full ? journalRepo(full.body) : null;
        if (repo !== null && repo !== repoKey) continue; // a different project's journal — skip
        const date = j.updatedAt.slice(0, 10); // YYYY-MM-DD, so same-goal tasks are distinguishable
        const outcome = j.excerpt.trim(); // the journal's Outcome line — shallow recall without a Read
        lines.push(`- "${j.title}"${/^\d{4}-\d\d-\d\d$/.test(date) ? ` (${date})` : ""}${outcome ? ` — ${outcome}` : ""} — ${root ? join(root, j.path) : j.path}`);
      }
      if (lines.length > 0) {
        sections.push(
          `Past task records for ${repoKey} in System Memory — each is a finished task's journal (its plan, research findings under a "## Reports" section, review, and outcome; the one-line outcome is shown). When the CEO refers to earlier work, a past task, or a research finding — OR asks a fresh question a journal below likely already answers — READ the matching file with your Read tool and answer from its ACTUAL contents (cite it); never guess what a journal says. This lists the most recent; older journals live under journals/ — Glob/Grep there if you don't see a match:\n\n${lines.join("\n")}`
        );
      }

      return sections.join("\n\n");
    } catch {
      return "";
    }
  }

  /** The dirs Iris's read-only tools may reach beyond her repo cwd — the Memory vault, so
   *  she can open a past task's journal. undefined when there's no on-disk vault (tests). */
  private memoryReadDirs(): string[] | undefined {
    const root = this.d.memory.root();
    return root ? [root] : undefined;
  }

  /** Inline text attachments into the message content; save image attachments to a
   *  temp dir so the agent can VIEW them with its Read tool. Returns the message to
   *  persist + the saved images (name + on-disk path) for Iris's --add-dir. */
  private async prepareAttachments(
    content: string,
    attachments: readonly Attachment[] | undefined,
    conversationId: string
  ): Promise<{ messageContent: string; images: { name: string; path: string }[]; imagesDir: string | null }> {
    if (!attachments || attachments.length === 0) return { messageContent: content, images: [], imagesDir: null };
    const TEXT_CAP = 200_000;
    const parts: string[] = content.trim() ? [content.trim()] : [];
    const images: { name: string; path: string }[] = [];
    let imagesDir: string | null = null;
    for (const a of attachments) {
      if (a.kind === "text") {
        const body = a.content.length > TEXT_CAP ? `${a.content.slice(0, TEXT_CAP)}\n…[truncated]` : a.content;
        // A fence longer than any backtick run IN the body, so a file that contains
        // ``` (markdown/code files do) can't close the wrapper early (CommonMark).
        const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
        const fence = "`".repeat(Math.max(3, longest + 1));
        parts.push(`--- Attached file: ${a.name} ---\n${fence}\n${body}\n${fence}`);
      } else {
        if (imagesDir === null) {
          // A per-TURN subdir so --add-dir exposes only this turn's images (not the
          // whole conversation's), and so it can be removed wholesale after the turn.
          imagesDir = join(tmpdir(), "bureau-attachments", conversationId, this.d.ids());
          await mkdir(imagesDir, { recursive: true });
        }
        let safe = a.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "image";
        // The Read tool keys image rendering off the extension — ensure one (from the
        // authoritative mediaType) when the sanitized name lacks it.
        if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(safe)) safe += extForImage(a.mediaType);
        const path = join(imagesDir, `${this.d.ids()}-${safe}`);
        await writeFile(path, Buffer.from(a.content, "base64"));
        images.push({ name: a.name, path });
        parts.push(`[Image attached: ${a.name}]`);
      }
    }
    return { messageContent: parts.join("\n\n") || "(attachments)", images, imagesDir };
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

  /** On boot, recover tasks a crash/forced-exit left mid-flight. After a restart
   *  `this.running` is empty, so no pipeline is driving them. Mark each INTERRUPTED
   *  (not aborted) and KEEP its worktree on disk, so the CEO can Resume (re-run clean
   *  from base) or Discard from the panel — instead of silently losing in-flight work.
   *  Resuming is never automatic (a re-run spends tokens — the CEO's call). */
  async reconcile(): Promise<number> {
    let interrupted = 0;
    for (const task of this.d.store.list()) {
      if (task.status !== "planning" && task.status !== "executing") continue;
      try {
        const marked = this.drive(task, {
          type: "INTERRUPT_TASK",
          reason: "The engine restarted while this task was running.",
        });
        this.emitTaskUpdated(marked);
        // Deliberately DO NOT remove the worktree — resume reuses it (reset to base).
        interrupted++;
      } catch {
        /* best-effort per task */
      }
    }
    return interrupted;
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
    // A task only needs the pr_approval (review-and-merge) gate if it MUTATES files.
    // A purely read-only pipeline (plan/review/test only) produces no diff to merge —
    // it completes with the workers' reports, with no gate.
    const mutates = proposal.steps.some((s) => s.capability === "edit" || s.capability === "document");
    const steps: Step[] = proposal.steps.map((s, i) => ({
      id: this.d.ids() as StepId,
      capability: s.capability,
      description: s.description,
      acceptanceCriteria: [],
      status: "pending",
      artifactIds: [],
      ...(mutates && i === lastIdx ? { gateAfter: gateId as GateId } : {}),
    }));
    const task: Task = {
      id: taskId as TaskId,
      goal: proposal.title,
      projectId: project.id,
      repoOwner: project.owner,
      repoName: project.name,
      status: "created",
      steps,
      // The single human gate is the pr_approval gate — the final confirm-merge. A
      // read-only task has none (nothing to merge).
      gates: mutates ? [{ id: gateId as GateId, kind: "pr_approval", status: "pending" }] : [],
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
  /** Race a worker's execute() against a wall-clock budget so a hung/never-settling
   *  worker can't park a task forever. On timeout it rejects → the existing pipeline
   *  catch fails the step + aborts. The underlying promise (and any CLI subprocess,
   *  which self-kills sooner) is left to settle/clean up on its own. */
  private withStepTimeout<T>(capability: string, p: Promise<T>): Promise<T> {
    const ms = capability === "test" ? TEST_STEP_TIMEOUT_MS : STEP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Step "${capability}" exceeded its time budget (${Math.round(ms / 1000)}s).`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private async runPipeline(taskId: string): Promise<void> {
    const branch = this.branchFor(taskId);
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

      await this.executeFromExecuting(taskId, project, vcs, worktreePath);
    } catch (err) {
      await this.failPipeline(taskId, undefined, err);
    }
  }

  /** The execute phase — run every pending step, enforce the budget cap, then commit +
   *  open the review gate (mutating task) or complete directly (read-only). Owns its own
   *  failPipeline so a thrown step is marked failed. Re-entered VERBATIM by resumeTask
   *  after a worktree reset, so a resumed run is identical to a fresh first run. It only
   *  ever drives the LOCAL pipeline up to OPEN_GATE — it NEVER pushes. */
  private async executeFromExecuting(taskId: string, project: ProjectConfig, vcs: VcsPort, worktreePath: string): Promise<void> {
    let currentStepId: StepId | undefined;
    try {
      let task = this.requireTask(taskId);
      // Running tally of this task's model spend, for the budget guard (0 cap = off).
      let spentUsd = 0;
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
        // A review worker assesses the change so far — hand it the FULL change vs
        // base (incl. uncommitted), so it sees the whole PR-shaped diff on a re-run
        // too (where earlier work is already committed), not just the increment.
        const reviewDiff =
          step.capability === "review" ? await vcs.reviewDiff(worktreePath, `origin/${project.baseBranch}`) : undefined;
        const testCommand = step.capability === "test" ? project.testCommand : undefined;
        const out = await this.withStepTimeout(
          step.capability,
          this.d.capabilities.get(step.capability).execute({
            step,
            worktreePath,
            context: this.stepContext(taskId, planned.id),
            model: resolveModel(this.modelPolicy, step.capability),
            ...(reviewDiff !== undefined ? { diff: reviewDiff } : {}),
            ...(testCommand !== undefined ? { testCommand } : {}),
            // Pipe the worker's live output to the panel as it works.
            onChunk: (chunk) =>
              this.d.events.emit({ type: "step_progress", taskId, stepId: planned.id, capability: step.capability, chunk }),
          })
        );
        this.recordUsage(step.capability, taskId, out.usage); // tokens were spent regardless of a concurrent stop
        if (out.usage) spentUsd += costUsd(out.usage.model, out.usage.inputTokens, out.usage.outputTokens);
        if (this.requireTask(taskId).status !== "executing") return; // stopped during the step
        if (out.artifacts.length > 0) this.addArtifacts(this.requireTask(taskId), out.artifacts);

        // Persist the worker's report so it survives the live stream + reloads.
        this.drive(this.requireTask(taskId), { type: "COMPLETE_STEP", stepId: planned.id, summary: out.summary });
        currentStepId = undefined;
        this.d.events.emit({ type: "step_completed", taskId, stepId: planned.id });
        this.notifyTestFailure(taskId, step.capability, out.summary); // advisory red flag, never blocks

        // Budget guard: stop BEFORE the next step once the running spend crosses the cap,
        // so a runaway pipeline can't bill unbounded. The just-finished step counts; the
        // throw is caught below → a clean abort (the step is already completed, not failed).
        if (this.budgetUsd > 0 && spentUsd > this.budgetUsd) {
          throw new Error(
            `Budget cap reached: this task has spent ~$${spentUsd.toFixed(2)} of its $${this.budgetUsd.toFixed(2)} cap. Stopping before the next step.`
          );
        }
      }

      // A read-only task (plan/review/test only) has no gate: there's no diff to
      // commit or merge — the workers' reports ARE the deliverable. Complete it
      // directly (never abort it as a false "no changes" failure).
      const gate = this.requireTask(taskId).gates[0];
      if (gate === undefined) {
        task = this.drive(this.requireTask(taskId), { type: "COMPLETE_TASK" });
        // Journal BEFORE the task_updated emit: the Memory tab refreshes on that event,
        // so the note must already be on disk or the refresh races ahead of the write
        // (journalTask is best-effort — it never throws, so the emit always follows).
        await this.journalTask(task);
        this.emitTaskUpdated(task);
        return;
      }

      // Mutating task: capture the diff (incl. new files), commit it locally on the
      // branch, then open the review gate.
      const diff = await vcs.workingDiff(worktreePath);
      if (this.requireTask(taskId).status !== "executing") return; // stopped before commit
      const committed = await vcs.commitAll(worktreePath, `Bureau: ${truncate(this.requireTask(taskId).goal)}`);
      task = this.requireTask(taskId);
      if (task.status !== "executing") return; // stopped during commit
      // Fail loud on a no-op run: a mutating task that committed nothing means the
      // worker produced no change — never park an empty task at the review gate.
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

      task = this.drive(task, { type: "OPEN_GATE", gateId: gate.id });
      this.d.events.emit({ type: "gate_opened", taskId, gateId: gate.id, gateKind: "pr_approval" });
      this.notify("review", taskId, "Ready for your review", `“${truncate(task.goal)}” finished and is waiting for you to review & merge.`);
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
      this.notify("failed", task.id, "A task failed", `“${truncate(task.goal)}” stopped: ${errMessage(err)}`);
      await this.journalTask(task);
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

  /** Re-run the pipeline with the CEO's change request, then re-open the gate for a
   *  fresh review of the FULL updated diff. Background + race-safe like runPipeline:
   *  it commits locally and NEVER pushes; an error aborts the task (failPipeline).
   *  The worktree from the first run is reused (it still holds the v1 change). */
  private async reRun(taskId: string, gateId: GateId, notes: string): Promise<void> {
    let currentStepId: StepId | undefined;
    try {
      const project = this.resolveProject(this.requireTask(taskId));
      const vcs = this.d.vcs(project);
      const worktreePath = requireWorktree(this.requireTask(taskId));

      // Re-open the loop: gate→pending, ALL steps→pending, status→executing.
      let task = this.drive(this.requireTask(taskId), { type: "REOPEN_FOR_CHANGES", gateId });
      this.emitTaskUpdated(task);
      const changeRequest = `The reviewer (CEO) reviewed the previous diff and requested these changes:\n${notes}`;

      for (const planned of task.steps) {
        if (this.requireTask(taskId).status !== "executing") return; // stopped between steps
        currentStepId = planned.id;
        task = this.drive(this.requireTask(taskId), { type: "START_STEP", stepId: planned.id });
        this.d.events.emit({ type: "step_started", taskId, stepId: planned.id });

        const step = task.steps.find((s) => s.id === planned.id)!;
        if (!this.d.capabilities.has(step.capability)) {
          throw new Error(`Capability "${step.capability}" is not available yet.`);
        }
        const reviewDiff =
          step.capability === "review" ? await vcs.reviewDiff(worktreePath, `origin/${project.baseBranch}`) : undefined;
        const testCommand = step.capability === "test" ? project.testCommand : undefined;
        const out = await this.withStepTimeout(
          step.capability,
          this.d.capabilities.get(step.capability).execute({
            step,
            worktreePath,
            context: this.stepContext(taskId, planned.id, changeRequest),
            model: resolveModel(this.modelPolicy, step.capability),
            ...(reviewDiff !== undefined ? { diff: reviewDiff } : {}),
            ...(testCommand !== undefined ? { testCommand } : {}),
            onChunk: (chunk) =>
              this.d.events.emit({ type: "step_progress", taskId, stepId: planned.id, capability: step.capability, chunk }),
          })
        );
        this.recordUsage(step.capability, taskId, out.usage);
        if (this.requireTask(taskId).status !== "executing") return; // stopped during the step
        if (out.artifacts.length > 0) this.addArtifacts(this.requireTask(taskId), out.artifacts);
        this.drive(this.requireTask(taskId), { type: "COMPLETE_STEP", stepId: planned.id, summary: out.summary });
        currentStepId = undefined;
        this.d.events.emit({ type: "step_completed", taskId, stepId: planned.id });
        this.notifyTestFailure(taskId, step.capability, out.summary);
      }

      if (this.requireTask(taskId).status !== "executing") return; // stopped before commit
      const committed = await vcs.commitAll(worktreePath, `Bureau: ${truncate(this.requireTask(taskId).goal)}`);
      task = this.requireTask(taskId);
      if (task.status !== "executing") return; // stopped during commit
      if (!committed) {
        // The revision made no change. Don't discard the reviewable work — re-open the
        // gate on the UNCHANGED diff so the CEO can still approve it or ask for
        // something different (the latest diff artifact is still the prior one).
        task = this.drive(task, { type: "OPEN_GATE", gateId });
        this.d.events.emit({ type: "gate_opened", taskId, gateId, gateKind: "pr_approval" });
        this.notify("review", taskId, "No changes made", `“${truncate(task.goal)}” — the revision produced no change. The diff is unchanged; approve it or request something different.`);
        this.emitTaskUpdated(task);
        return;
      }
      // The FULL change vs the branch base (three-dot, merge-base relative), not just
      // the increment over the first commit that the working diff would show.
      const diff = await vcs.branchDiff(worktreePath, `origin/${project.baseBranch}`);
      const lastStep = task.steps[task.steps.length - 1]!.id;
      task = this.addArtifacts(task, [
        { id: this.d.ids() as ArtifactId, kind: "diff", ref: diff, producedByStep: lastStep, createdAt: this.d.clock() },
      ]);
      task = this.drive(task, { type: "OPEN_GATE", gateId });
      this.d.events.emit({ type: "gate_opened", taskId, gateId, gateKind: "pr_approval" });
      this.notify("review", taskId, "Re-review ready", `“${truncate(task.goal)}” was revised and is ready for your review again.`);
      this.emitTaskUpdated(task);
    } catch (err) {
      await this.failPipeline(taskId, currentStepId, err);
    }
  }

  /** Stop a task: abort and tear down its worktree. Idempotent on terminal tasks. */
  async stopTask(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (task.status === "completed" || task.status === "aborted") return task; // already resolved
    task = this.drive(task, { type: "ABORT_TASK", reason: "Stopped by the CEO." });
    this.emitTaskUpdated(task);
    await this.journalTask(task);
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

  /** Resume an INTERRUPTED task (after an engine restart): reset its worktree to a
   *  pristine base — discarding any partial/crash work — rebuild the pipeline fresh, and
   *  re-run it in the background exactly like a first run, parking at the same review
   *  gate. It NEVER pushes (re-enters only the local execute loop). Re-running spends
   *  tokens, so it's the CEO's explicit choice — never automatic on boot. */
  async resumeTask(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (task.status !== "interrupted") {
      throw new OrchestratorError(`Task ${taskId} is not resumable (status ${task.status}).`, 409);
    }
    if (this.running.has(taskId)) {
      throw new OrchestratorError(`Task ${taskId} is already running.`, 409);
    }
    const project = this.resolveProject(task);
    const vcs = this.d.vcs(project);
    const branch = this.branchFor(taskId);
    const worktreePath = task.worktreePath ?? join(project.worktreesDir, taskId);
    await vcs.ensureClone();
    // If the worktree survived the crash, RESET it to base (drop any partial/crash bytes —
    // incl. a half-applied edit). If it never got created (crash during planning), make it
    // fresh, clearing any stale bureau/task-* branch first (namespace-constrained, safe).
    if (task.worktreePath !== undefined && existsSync(join(worktreePath, ".git"))) {
      await vcs.resetWorktreeToBase(worktreePath);
    } else {
      // No usable worktree (crashed before/mid setup, or its .git link is gone). Clear any
      // leftover dir + its stale worktree admin entry + branch, THEN create a clean one —
      // otherwise `git worktree add` fails ("already exists" / "already registered") and
      // resume is stuck. The dir is engine-derived under worktreesDir; guard it anyway.
      if (resolve(worktreePath).startsWith(resolve(project.worktreesDir) + sep)) {
        await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      }
      await vcs.pruneWorktrees().catch(() => {}); // drop a stale admin entry pointing at it
      await vcs.deleteBranch(branch).catch(() => {}); // clear a stale bureau/task-* branch
      await vcs.setupWorktree(branch, worktreePath);
    }
    this.setWorktree(this.requireTask(taskId), worktreePath);
    // RESUME_TASK rebuilds every step + gate as fresh pending and returns to executing —
    // so the re-run is identical to a first run and can never inherit a stale approval.
    task = this.drive(this.requireTask(taskId), { type: "RESUME_TASK" });
    this.emitTaskUpdated(task);
    const promise = this.executeFromExecuting(taskId, project, vcs, worktreePath);
    this.running.set(taskId, promise);
    void promise.finally(() => this.running.delete(taskId));
    return this.requireTask(taskId);
  }

  /** Discard an interrupted task — abort it and tear down its worktree (the path the
   *  CEO takes instead of Resume). Delegates to stopTask (idempotent abort + cleanup). */
  async discardTask(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.status !== "interrupted") {
      throw new OrchestratorError(`Task ${taskId} is not interrupted (status ${task.status}).`, 409);
    }
    return this.stopTask(taskId);
  }

  /** Permanently remove a task. If it's still live, stop it first (aborts + tears
   *  down its worktree) so nothing is left orphaned, then delete the record. The
   *  task's bureau/task-* branch (if it ever pushed one) is left for the Git
   *  "clean up branches" action — deleting a record never reaches GitHub. */
  async deleteTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId); // 404s if unknown
    if (task.status !== "completed" && task.status !== "aborted") {
      await this.stopTask(taskId); // abort the task
      await this.settle(taskId); // the background pipeline has now released the worktree path
      // For a STILL-RUNNING task, stopTask only SCHEDULES the worktree teardown
      // (detached, not tracked in `running`), so settle() above doesn't guarantee
      // it ran. Tear it down inline and AWAIT it before dropping the record — else
      // the 204 races ahead of the teardown and a shutdown could orphan the worktree.
      const aborted = this.requireTask(taskId);
      if (aborted.worktreePath !== undefined) {
        const vcs = this.vcsForTask(aborted);
        if (vcs) await vcs.removeWorktree({ path: aborted.worktreePath, branch: this.branchFor(taskId) }, true).catch(() => {});
      }
    }
    this.d.store.delete(taskId as TaskId);
    // Tell every open panel to refresh its lists; the deleted task now 404s.
    this.d.events.emit({ type: "task_updated", taskId, status: "deleted" });
  }

  /** The CEO's decision at the open review gate. Three outcomes, ONE entry point:
   *   - approved        → confirmMerge (the unchanged, sole push path)
   *   - rejected        → abort the task (push nothing, tear down the worktree)
   *   - request_changes → re-run the edit with the CEO's notes, then re-review.
   *  Only `approved` can ever reach GitHub, and only via confirmMerge's canPush wall. */
  async decideGate(taskId: string, decision: HumanDecision, notes?: string): Promise<Task> {
    const task = this.requireTask(taskId);
    const gate = task.gates.find((g) => g.status === "open");
    if (gate === undefined) {
      throw new OrchestratorError(`Task ${taskId} has no open review gate.`, 409);
    }

    if (decision === "approved") return this.confirmMerge(taskId);

    if (decision === "rejected") {
      // Record the rejection in the log, then abort + clean up (stopTask is idempotent).
      this.drive(task, { type: "DECIDE_GATE", gateId: gate.id, decision: "rejected", ...(notes !== undefined ? { notes } : {}) });
      return this.stopTask(taskId);
    }

    // request_changes — needs a note so the worker has something to act on.
    const trimmed = (notes ?? "").trim();
    if (trimmed === "") {
      throw new OrchestratorError("Requesting changes needs a note describing what to change.", 400);
    }
    const decided = this.drive(task, { type: "DECIDE_GATE", gateId: gate.id, decision: "request_changes", notes: trimmed });
    this.emitTaskUpdated(decided);
    // Re-run in the BACKGROUND (like startTask) — it commits locally + re-opens the
    // gate; it NEVER pushes. Return immediately so the panel shows live progress.
    const promise = this.reRun(taskId, gate.id, trimmed);
    this.running.set(taskId, promise);
    void promise.finally(() => this.running.delete(taskId));
    return this.requireTask(taskId);
  }

  /** The CEO's final confirmation: push, open the PR, squash-merge to main, clean up.
   *  Delegates to landBranch — the ONE code path that reaches GitHub, only when canPush(). */
  async confirmMerge(taskId: string): Promise<Task> {
    return this.landBranch(taskId, true);
  }

  /** Push the branch + open a PR for review on GitHub, but DON'T merge it — the branch
   *  and the open PR live on GitHub for the CEO to test and merge (or close) there. The
   *  SAME security wall as a merge: the gate approval authorizes the push, canPush() must
   *  hold; it simply stops before mergePr and keeps the branch (no --delete). */
  async openPrForReview(taskId: string): Promise<Task> {
    return this.landBranch(taskId, false);
  }

  /** Merge the PR of a task that was earlier "Open PR (no merge)"'d — the deferred merge,
   *  so the CEO can finish from Bureau instead of being stranded on GitHub. Squash-merges
   *  the already-open PR + deletes the branch. canPush()-gated like every merge (the task
   *  is completed with its gate approved). On failure records an honest merge_error. */
  async mergeOpenPr(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (isMerged(task)) return task; // idempotent — a racing 2nd call must not record a false error
    if (this.merging.has(taskId)) {
      throw new OrchestratorError(`Task ${taskId} is already being merged.`, 409); // serialize concurrent merges
    }
    if (!prOpen(task)) {
      throw new OrchestratorError(`Task ${taskId} has no open PR awaiting a merge.`, 409);
    }
    // ── THE SECURITY WALL ── (mergePr only ever runs behind canPush)
    if (!canPush(task)) {
      throw new OrchestratorError(`Task ${taskId} isn't authorized to merge.`, 409);
    }
    this.merging.add(taskId);
    try {
      const vcs = this.d.vcs(this.resolveProject(task));
      const branch = this.branchFor(task.id);
      const url = prUrl(task) ?? "";
      const lastStep = task.steps[task.steps.length - 1]!.id;
      try {
        await vcs.mergePr(branch);
        // Record the MERGED PR (pr_url) so the task now reads "merged", not "PR open".
        task = this.addArtifacts(task, [{ id: this.d.ids() as ArtifactId, kind: "pr_url", ref: url, producedByStep: lastStep, createdAt: this.d.clock() }]);
        this.notify("merged", task.id, "Merged to main", `“${truncate(task.goal)}” is merged${url ? ` — ${url}` : ""}.`);
      } catch (err) {
        // The PR is still open + mergeable (prOpen tolerates a merge_error), so the CEO
        // keeps the in-Bureau retry — this records an honest error, not a dead end.
        this.notify("merge_failed", task.id, "Merge didn't land", `“${truncate(task.goal)}” couldn't merge: ${errMessage(err)}${url ? ` (PR ${url})` : ""}`);
        task = this.addArtifacts(task, [{ id: this.d.ids() as ArtifactId, kind: "merge_error", ref: errMessage(err), producedByStep: lastStep, createdAt: this.d.clock() }]);
      }
      this.emitTaskUpdated(task);
      await this.journalTask(task);
      return task;
    } finally {
      this.merging.delete(taskId);
    }
  }

  /** Recovery for a task whose land FAILED before any base existed (the first task on an
   *  empty repo: its branch is already on origin, but `gh pr create` had no base to target).
   *  Re-lands from origin — establishes the base from the pushed branch, or, if a base
   *  appeared meanwhile, opens + squash-merges a PR. canPush()-gated exactly like every
   *  merge; the branch is recomputed from the task id (never from request input). */
  async establishBaseForTask(taskId: string): Promise<Task> {
    let task = this.requireTask(taskId);
    if (isMerged(task)) return task; // idempotent — a racing 2nd call must not double-land
    if (this.merging.has(taskId)) {
      throw new OrchestratorError(`Task ${taskId} is already being landed.`, 409); // serialize
    }
    if (task.status !== "completed") {
      throw new OrchestratorError(`Task ${taskId} isn't completed — nothing to land.`, 409);
    }
    if (prOpen(task)) {
      throw new OrchestratorError(`Task ${taskId} has an open PR — merge that instead.`, 409); // use mergeOpenPr
    }
    // ── THE SECURITY WALL ── (every origin write stays behind canPush)
    if (!canPush(task)) {
      throw new OrchestratorError(`Task ${taskId} isn't authorized to land.`, 409);
    }
    this.merging.add(taskId);
    try {
      const project = this.resolveProject(task);
      const vcs = this.d.vcs(project);
      const branch = this.branchFor(task.id);
      const lastStep = task.steps[task.steps.length - 1]!.id;
      try {
        if (await vcs.baseExists()) {
          // A base exists now (the repo was initialized meanwhile) — open + squash-merge a
          // PR against the already-pushed branch: the normal land. Record pr_open the INSTANT
          // the PR exists, BEFORE mergePr — so a mergePr failure leaves the task in the prOpen
          // state (→ the in-Bureau "Merge to main" retry via mergeOpenPr), never a dead end
          // that would re-open an already-open PR on the next click.
          const url = await vcs.openPr(branch, `Bureau: ${truncate(task.goal)}`, prBody(task.goal));
          task = this.addArtifacts(task, [{ id: this.d.ids() as ArtifactId, kind: "pr_open", ref: url, producedByStep: lastStep, createdAt: this.d.clock() }]);
          await vcs.mergePr(branch);
          task = this.addArtifacts(task, [{ id: this.d.ids() as ArtifactId, kind: "pr_url", ref: url, producedByStep: lastStep, createdAt: this.d.clock() }]);
          this.notify("merged", task.id, "Merged to main", `“${truncate(task.goal)}” is merged — ${url}`);
        } else {
          // Still empty — establish the base from the pushed branch (the worktree is gone,
          // so push origin/<branch> from the canonical clone). The task branch was pushed
          // first under the old flow, so it may be origin's default: pin the default to main
          // FIRST, which both fixes the default and makes the task branch deletable.
          await vcs.establishBaseFromOrigin(branch);
          await vcs.setDefaultBranch().catch(() => {});
          task = this.addArtifacts(task, [{ id: this.d.ids() as ArtifactId, kind: "base_established", ref: `https://github.com/${task.repoOwner}/${task.repoName}`, producedByStep: lastStep, createdAt: this.d.clock() }]);
          await vcs.deleteBranch(branch).catch(() => {});
          this.notify("merged", task.id, "Initialized main", `“${truncate(task.goal)}” established ${project.baseBranch} on an empty repo — your work is its first commit.`);
        }
      } catch (err) {
        this.notify("merge_failed", task.id, "Couldn't land", `“${truncate(task.goal)}” couldn't land: ${errMessage(err)}`);
        task = this.addArtifacts(task, [{ id: this.d.ids() as ArtifactId, kind: "merge_error", ref: errMessage(err), producedByStep: lastStep, createdAt: this.d.clock() }]);
      }
      this.emitTaskUpdated(task);
      await this.journalTask(task);
      return task;
    } finally {
      this.merging.delete(taskId);
    }
  }

  /** THE single GitHub-reaching path. Approve the open pr_approval gate, complete the
   *  task, and — only when canPush()===true — push the branch and open its PR; when
   *  `merge`, also squash-merge to main and delete the branch. push()/openPr()/mergePr()
   *  live ONLY here, behind the canPush wall. */
  private async landBranch(taskId: string, merge: boolean): Promise<Task> {
    let task = this.requireTask(taskId);
    const gate = task.gates.find((g) => g.status === "open");
    if (gate === undefined) {
      throw new OrchestratorError(`Task ${taskId} has no open review gate.`, 409);
    }
    // Only the pr_approval gate authorizes a push. (canPush() independently requires
    // it, so this never weakens the wall — it just fails fast + documents intent.)
    if (gate.kind !== "pr_approval") {
      throw new OrchestratorError(`Task ${taskId}'s open gate is "${gate.kind}", not a merge approval.`, 409);
    }

    task = this.drive(task, { type: "DECIDE_GATE", gateId: gate.id, decision: "approved" });
    task = this.drive(task, { type: "COMPLETE_TASK" });
    this.emitTaskUpdated(task);

    // ── THE SECURITY WALL ──────────────────────────────────────────────────
    if (!canPush(task)) {
      console.warn(`[engine] landBranch: canPush is false for task ${task.id} — nothing pushed.`);
      return task;
    }
    // Resolve push + PR/merge from ONE project (the task's stable id), so the
    // branch and the PR can never target different repos.
    const project = this.resolveProject(task);
    const vcs = this.d.vcs(project);
    const worktreePath = requireWorktree(task);
    const branch = this.branchFor(task.id);
    const title = `Bureau: ${truncate(task.goal)}`;
    const lastStep = task.steps[task.steps.length - 1]!.id;
    let prUrl: string | undefined;
    try {
      if (!(await vcs.baseExists())) {
        // First task on an EMPTY repo: origin has no base branch, so there's nothing to
        // open a PR against — the branch's content IS the initial main. Push it STRAIGHT to
        // the base branch (its FIRST branch on origin → GitHub's default), then pin the
        // default explicitly. Deliberately NOT push()ing the task branch first: that would
        // make IT origin's default (and an undeletable leftover). No --force, so an existing
        // main can never be clobbered. Both confirm-merge and open-PR collapse here — a
        // review PR is impossible without a base.
        await vcs.establishBase(worktreePath, branch);
        await vcs.setDefaultBranch().catch(() => {}); // belt-and-suspenders: main IS the default
        task = this.addArtifacts(task, [
          { id: this.d.ids() as ArtifactId, kind: "base_established", ref: `https://github.com/${task.repoOwner}/${task.repoName}`, producedByStep: lastStep, createdAt: this.d.clock() },
        ]);
        this.notify("merged", task.id, "Initialized main", `“${truncate(task.goal)}” established ${project.baseBranch} on an empty repo — your work is its first commit.`);
      } else {
        await vcs.push(worktreePath, branch);
        prUrl = await vcs.openPr(branch, title, prBody(task.goal));
        if (merge) {
          await vcs.mergePr(branch);
          // Full success — the change is on main. Record the MERGED PR.
          task = this.addArtifacts(task, [
            { id: this.d.ids() as ArtifactId, kind: "pr_url", ref: prUrl, producedByStep: lastStep, createdAt: this.d.clock() },
          ]);
          this.notify("merged", task.id, "Merged to main", `“${truncate(task.goal)}” is merged — ${prUrl}`);
        } else {
          // PR opened for review — NOT merged. The branch stays on GitHub for the CEO.
          task = this.addArtifacts(task, [
            { id: this.d.ids() as ArtifactId, kind: "pr_open", ref: prUrl, producedByStep: lastStep, createdAt: this.d.clock() },
          ]);
          this.notify("review", task.id, "PR opened for review", `“${truncate(task.goal)}” is on GitHub as an open PR — review and merge it there: ${prUrl}`);
        }
      }
    } catch (err) {
      // The push/PR/merge didn't complete (e.g. conflicts, branch protection). Record an
      // honest merge_error so the panel shows "didn't land" instead of a false success —
      // keeping the PR link (if one was opened) so the CEO can resolve it on GitHub. The
      // task stays `completed` (the CEO approved + did their part).
      console.error(`[engine] ${merge ? "merge" : "open-PR"} failed for task ${task.id}: ${errMessage(err)}${prUrl !== undefined ? ` (PR opened: ${prUrl})` : ""}`);
      this.notify("merge_failed", task.id, merge ? "Merge didn't land" : "Couldn't open the PR", `“${truncate(task.goal)}” ${merge ? "couldn't merge" : "couldn't open a PR"}: ${errMessage(err)}${prUrl !== undefined ? ` (PR ${prUrl})` : ""}`);
      task = this.addArtifacts(task, [
        ...(prUrl !== undefined
          ? [{ id: this.d.ids() as ArtifactId, kind: "pr_url" as const, ref: prUrl, producedByStep: lastStep, createdAt: this.d.clock() }]
          : []),
        { id: this.d.ids() as ArtifactId, kind: "merge_error", ref: errMessage(err), producedByStep: lastStep, createdAt: this.d.clock() },
      ]);
      this.emitTaskUpdated(task);
    } finally {
      // Always release the local worktree (the work now lives on the branch / PR).
      await vcs.removeWorktree({ path: worktreePath, branch }, true).catch(() => {});
    }
    await this.journalTask(task); // record the outcome in the vault
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

  /** A step's context: the goal, an optional change request (on a re-run), and the
   *  summaries of the steps already run in this task — so each worker builds on the
   *  prior ones (the edit follows the plan; document/review see what changed). */
  private stepContext(taskId: string, currentStepId: StepId, changeRequest?: string): string {
    const task = this.requireTask(taskId);
    const parts = [task.goal];
    if (changeRequest) parts.push(changeRequest);
    const idx = task.steps.findIndex((s) => s.id === currentStepId);
    const prior = task.steps.slice(0, Math.max(0, idx)).filter((s) => s.summary !== undefined && s.summary !== "");
    if (prior.length > 0) {
      parts.push(
        "Earlier steps in this task already produced:\n" +
          prior.map((s) => `### ${ASSIGNEE[s.capability]} (${s.capability}):\n${s.summary}`).join("\n\n")
      );
    }
    return parts.join("\n\n");
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

/** A file extension for a saved image attachment, derived from its media type — so
 *  the Read tool (which keys image rendering off the extension) renders it. */
function extForImage(mediaType?: string): string {
  switch ((mediaType ?? "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/bmp":
      return ".bmp";
    case "image/svg+xml":
      return ".svg";
    default:
      return ".png";
  }
}

/** A concise, read-only summary of the repo's git state for Iris's context — so she
 *  can answer about branches and history without a shell (she has only Read tools). */
export function buildRepoContext(view: RepoView): string {
  if (!view.cloned) return "";
  const real = view.branches.filter((b) => !b.startsWith("bureau/"));
  const internal = view.branches.filter((b) => b.startsWith("bureau/"));
  // Branches that exist LOCALLY but are NOT on origin yet — Iris must know these so she
  // never tells the CEO a real branch "doesn't exist" just because it isn't on GitHub.
  const originSet = new Set(view.branches);
  const localOnly = (view.localBranches ?? []).filter((b) => !b.startsWith("bureau/") && !originSet.has(b));
  const lines = ["Repository git state (read-only, current — provided to you so you do NOT need to run git):"];
  if (view.branch) lines.push(`- Checked-out branch: ${view.branch}`);
  lines.push(
    `- Branches on GitHub (origin): ${real.join(", ") || "(none)"}` +
      (internal.length > 0 ? ` — plus ${internal.length} leftover Bureau task branch(es): ${internal.join(", ")}` : "")
  );
  if (localOnly.length > 0) {
    lines.push(
      `- Local-only branches (these EXIST locally with their content, but are NOT on GitHub yet): ${localOnly.join(", ")}. They are real — do NOT say they don't exist. To publish one to GitHub, propose a create_branch gitOp with that exact name (Bureau pushes the existing local branch as-is).`
    );
  }
  if (view.commits.length > 0) {
    lines.push("- Recent commits (newest first):");
    for (const c of view.commits.slice(0, 8)) lines.push(`  - ${c.hash} ${c.subject} (${c.author}, ${c.date})`);
  }
  lines.push(
    "This is the LIVE state, refreshed at the start of this turn — use it to answer about branches and history accurately, and do NOT claim it's a stale snapshot or that you can't see them. You can't run git yourself, but you CAN do branch/tag/history administration by PROPOSING a gitOp (the CEO authorizes it inline and Bureau mirrors it to GitHub) — never hand the CEO raw git commands to run."
  );
  return lines.join("\n");
}

/** Resolve + validate a CEO git-op request into a concrete GitAdminOp, plus the branch
 *  name the CEO must type to confirm a destructive op (empty for safe ops). */
function resolveGitOp(req: GitOpRequest): { op: GitAdminOp; confirmTarget: string } {
  const need = (v: string | undefined, field: string): string => {
    if (v === undefined || v.trim() === "") throw new OrchestratorError(`Missing "${field}" for this git operation.`, 400);
    return v;
  };
  switch (req.kind) {
    case "squash_all": {
      const branch = need(req.branch, "branch");
      return { op: { kind: "squash_all", branch, message: need(req.message, "message") }, confirmTarget: branch };
    }
    case "force_push": {
      const branch = need(req.branch, "branch");
      return { op: { kind: "force_push", branch }, confirmTarget: branch };
    }
    case "reset_hard": {
      const branch = need(req.branch, "branch");
      return { op: { kind: "reset_hard", ref: need(req.ref, "ref") }, confirmTarget: branch };
    }
    case "delete_branch": {
      const branch = need(req.branch, "branch");
      return { op: { kind: "delete_branch", branch }, confirmTarget: branch };
    }
    case "create_branch":
      return { op: { kind: "create_branch", name: need(req.name, "name"), ...(req.base ? { base: req.base } : {}) }, confirmTarget: "" };
    case "rename_branch":
      return { op: { kind: "rename_branch", from: need(req.from, "from"), to: need(req.to, "to") }, confirmTarget: "" };
    case "tag":
      return { op: { kind: "tag", name: need(req.name, "name"), ...(req.message ? { message: req.message } : {}) }, confirmTarget: "" };
    case "fetch":
      return { op: { kind: "fetch" }, confirmTarget: "" };
  }
}

function gitOpDone(op: GitAdminOp): string {
  switch (op.kind) {
    case "squash_all":
      return `Squashed ${op.branch} into one commit and force-pushed.`;
    case "force_push":
      return `Force-pushed ${op.branch} (with lease).`;
    case "reset_hard":
      return `Hard-reset to ${op.ref}.`;
    case "create_branch":
      return `Created branch ${op.name}.`;
    case "rename_branch":
      return `Renamed ${op.from} to ${op.to}.`;
    case "delete_branch":
      return `Deleted branch ${op.branch}.`;
    case "tag":
      return `Created tag ${op.name}.`;
    case "fetch":
      return `Fetched and pruned from origin.`;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
