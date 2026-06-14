// Ports the orchestrator depends on. Real adapters wrap @bureau/db, @bureau/vcs,
// and the WebSocket hub; tests inject fakes. This keeps Iris's logic — including
// the canPush security gate — fully unit-testable with no DB, git, or network.

import type { Task, TaskId } from "@bureau/core";
import type { WsEvent, Message, Conversation } from "@bureau/contracts";

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
  /** Create the task's isolated worktree + branch. */
  setupWorktree(branch: string, worktreePath: string): Promise<WorktreeRef>;
  /** The uncommitted diff (incl. new files) — what the human reviews. */
  workingDiff(worktreePath: string): Promise<string>;
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
