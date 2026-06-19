// Ports the orchestrator depends on. Real adapters wrap @bureau/db, @bureau/vcs,
// and the WebSocket hub; tests inject fakes. This keeps Iris's logic — including
// the canPush security gate — fully unit-testable with no DB, git, or network.

import type { Task, TaskId } from "@bureau/core";
import type { WsEvent, Message, Conversation, Note, NoteSummary, UsageSummary, Notification, GitFileEntry, PullRequest, Issue, EntryCommit, CommitDetail } from "@bureau/contracts";

export interface TaskStore {
  save(task: Task): void;
  load(id: TaskId): Task | null;
  list(): Task[];
  /** Permanently remove a task and its child rows (steps/gates/artifacts/log). */
  delete(id: TaskId): void;
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
  /** Hard-reset + clean an EXISTING worktree back to the fresh base, discarding any
   *  uncommitted/partial crash work — so a RESUMED task re-runs from a pristine tree.
   *  LOCAL-ONLY (reset/clean), never on a push path. Keeps .gitignored build dirs. */
  resetWorktreeToBase(worktreePath: string): Promise<void>;
  /** Drop stale worktree admin entries so re-creating a worktree at a half-torn-down
   *  path doesn't fail "already registered". Best-effort; local-only. */
  pruneWorktrees(): Promise<void>;
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
  /** Delete ONE bureau/task-* branch (local + origin). Refuses any non-task ref.
   *  Returns true if it removed the branch. */
  deleteBranch(branch: string): Promise<boolean>;
  /** Execute a CEO-AUTHORIZED git admin operation (squash/force-push/branch/tag/…).
   *  The orchestrator validates the human confirm gate BEFORE calling this; the vcs
   *  layer re-validates every ref argv-side (assertSafeRef) and runs argv-only. */
  gitAdmin(op: GitAdminOp): Promise<void>;
  /** True when the canonical clone has no commits yet (an unborn-branch repo) or isn't
   *  cloned — so the read-only browser shows a "no commits yet" state instead of erroring
   *  when `ls-tree` can't resolve the base ref. */
  isEmpty(): Promise<boolean>;
  /** Read-only: one directory level of the codebase at `ref` (the embedded browser).
   *  Returns [] when the clone doesn't exist or has no commits. */
  listTree(ref: string, dir: string): Promise<GitFileEntry[]>;
  /** Read-only: a file's content at `ref`, capped. */
  showFile(ref: string, path: string): Promise<{ content: string; truncated: boolean }>;
  /** The GitHub account `gh` is signed in as (read-only), or null if not authenticated. */
  githubAccount(): Promise<{ login: string; name: string | null } | null>;
  /** Read-only: the repo's pull requests (via gh). Returns [] if gh can't read them. */
  prList(): Promise<PullRequest[]>;
  /** Read-only: the repo's issues (via gh). Returns [] if gh can't read them. */
  issueList(): Promise<Issue[]>;
  /** Read-only: the latest commit that touched each entry of `dir` at `ref` (the
   *  code browser's "latest commit" column). [] when the clone doesn't exist. */
  treeCommits(ref: string, dir: string): Promise<EntryCommit[]>;
  /** Read-only: one commit's metadata, file stats, and patch (capped). null if unknown. */
  commitDetail(ref: string): Promise<CommitDetail | null>;
  /** Read-only: every file path in the repo at `ref` (the "go to file" finder), capped. */
  listFiles(ref: string): Promise<{ paths: string[]; truncated: boolean }>;
  /** Read-only: commits that touched a file, newest first (file history). */
  fileHistory(ref: string, path: string): Promise<RepoCommit[]>;
}

/** A resolved, validated git-admin operation — the orchestrator builds this from the
 *  CEO's authorized request (after the type-to-confirm gate for destructive ops). */
export type GitAdminOp =
  | { kind: "squash_all"; branch: string; message: string }
  | { kind: "force_push"; branch: string }
  | { kind: "reset_hard"; ref: string }
  | { kind: "create_branch"; name: string; base?: string }
  | { kind: "rename_branch"; from: string; to: string }
  | { kind: "delete_branch"; branch: string }
  | { kind: "tag"; name: string; message?: string }
  | { kind: "fetch" };

/** A read-only snapshot of a project's repository, for the Git console. */
export interface RepoView {
  readonly cloned: boolean;
  readonly branch: string | null;
  readonly commits: readonly RepoCommit[];
  /** Branches on origin (GitHub). */
  readonly branches: readonly string[];
  /** Branches that exist LOCALLY (refs/heads) — may include some not yet pushed to
   *  origin. Optional so test fakes needn't supply it; the real adapter always does. */
  readonly localBranches?: readonly string[];
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
  /** Delete a note by its vault path (no-op if absent). */
  delete(path: string): Promise<void>;
  /** Persist a task journal at a deterministic path (best-effort, idempotent). */
  writeJournal(path: string, markdown: string): Promise<void>;
  /** The absolute on-disk vault directory — lets the chat grant Iris READ access to her
   *  own past task journals (she opens the relevant one with Read on demand). null for an
   *  in-memory/ephemeral vault with no real directory (tests). */
  root(): string | null;
}
