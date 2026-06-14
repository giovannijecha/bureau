// Ports the orchestrator depends on. Real adapters wrap @bureau/db, @bureau/vcs,
// and the WebSocket hub; tests inject fakes. This keeps Iris's logic — including
// the canPush security gate — fully unit-testable with no DB, git, or network.

import type { Task, TaskId } from "@bureau/core";
import type { WsEvent, Message, Conversation, Note, NoteSummary, UsageSummary, Notification } from "@bureau/contracts";

export interface TaskStore {
  save(task: Task): void;
  load(id: TaskId): Task | null;
  list(): Task[];
}

export interface WorktreeRef {
  readonly path: string;
  readonly branch: string;
}

/** High-level VCS operations Iris needs; the real adapter delegates to @bureau/vcs. */
export interface VcsPort {
  /** Clone the canonical repo if it isn't there yet (idempotent). */
  ensureClone(): Promise<void>;
  /** Ensure the clone exists AND its working tree is current with origin's base —
   *  so Iris reads the LIVE repo in chat, never a stale snapshot. Best-effort. */
  syncClone(): Promise<void>;
  /** Create the task's isolated worktree + branch. */
  setupWorktree(branch: string, worktreePath: string): Promise<WorktreeRef>;
  /** The uncommitted diff (incl. new files) — what the human reviews on the first run. */
  workingDiff(worktreePath: string): Promise<string>;
  /** The committed branch diff vs `base` (e.g. "origin/main") — the full PR-shaped
   *  change. Used to re-review after a request-changes re-run, where the working
   *  diff would show only the increment over the first commit. */
  branchDiff(worktreePath: string, base: string): Promise<string>;
  /** The full change vs `base` INCLUDING uncommitted work — what a mid-pipeline
   *  review worker should see (correct on both the first run and a re-run). */
  reviewDiff(worktreePath: string, base: string): Promise<string>;
  /** Stage + commit; returns false if there was nothing to commit. */
  commitAll(worktreePath: string, message: string): Promise<boolean>;
  /** Push the branch. Iris calls this ONLY after canPush()===true. */
  push(worktreePath: string, branch: string): Promise<void>;
  /** Open a PR and return its URL. Iris calls this ONLY after canPush()===true. */
  openPr(branch: string, title: string, body: string): Promise<string>;
  /** Squash-merge the branch's PR into main and delete it (the final merge). */
  mergePr(branch: string): Promise<void>;
  /** Tear down a worktree (force = remove even if dirty, for aborts). */
  removeWorktree(ref: WorktreeRef, force: boolean): Promise<void>;
  /** The directory Iris reads from in chat: the project's canonical clone if it
   *  exists, else an empty scratch dir — so she never reads unrelated files (e.g.
   *  the engine's own working directory). */
  chatCwd(): string;
  /** Read-only repo inspection for the Git console (current branch, recent commits,
   *  origin branches). Never mutates; returns empty when the clone doesn't exist. */
  repoInfo(commitLimit: number): Promise<RepoView>;
  /** Delete leftover bureau/task-* branches (local + origin) except `keep`. Hard-
   *  constrained to that namespace — never touches main or a user branch. Returns
   *  the branches removed. */
  pruneTaskBranches(keep: readonly string[]): Promise<string[]>;
}

/** A read-only snapshot of a project's repository, for the Git console. */
export interface RepoView {
  readonly cloned: boolean;
  readonly branch: string | null;
  readonly commits: readonly RepoCommit[];
  readonly branches: readonly string[];
}

export interface RepoCommit {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface EventSink {
  emit(event: WsEvent): void;
}

export interface MessageLog {
  append(message: Message): void;
  /** Every message across all conversations (used to migrate pre-thread messages). */
  list(): Message[];
  /** Messages in one conversation, in order. */
  listByConversation(conversationId: string): Message[];
  /** Assign conversation-less (pre-thread) messages to a conversation; returns count. */
  adoptOrphans(conversationId: string): number;
}

export interface ConversationStore {
  create(conversation: Conversation): void;
  get(id: string): Conversation | null;
  list(): Conversation[];
  rename(id: string, title: string, updatedAt: string): void;
  touch(id: string, updatedAt: string): void;
  delete(id: string): void;
}

/** One recorded provider round-trip's token spend (Iris chat or a worker step). */
export interface UsageEvent {
  readonly id: string;
  readonly day: string; // UTC YYYY-MM-DD
  readonly scope: string; // 'iris' | capability kind
  readonly taskId: string | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

/** Usage & Cost — append-only token spend + an aggregated summary. */
export interface UsagePort {
  record(event: UsageEvent): void;
  summary(sinceDay: string | null): UsageSummary;
}

/** Durable CEO notifications (review-ready / merged / failed). */
export interface NotificationStore {
  create(notification: Notification): void;
  list(limit?: number): Notification[];
  unreadCount(): number;
  markRead(id: string, readAt: string): void;
  markAllRead(readAt: string): void;
}

/** System Memory — the org's durable vault of markdown notes (task journals +
 *  free-form CEO/Iris notes). Backed by @bureau/mind on disk; faked in tests. */
export interface MemoryPort {
  /** Notes, newest first; filtered by a lexical query when given. */
  list(query?: string): Promise<NoteSummary[]>;
  /** One note (with body), or null if it doesn't exist. */
  get(path: string): Promise<Note | null>;
  /** Create/update a free-form CEO note from a title + body; returns the saved note. */
  saveNote(title: string, body: string): Promise<Note>;
  /** Persist a task journal at a deterministic path (best-effort, idempotent). */
  writeJournal(path: string, markdown: string): Promise<void>;
}
