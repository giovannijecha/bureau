// Ports the orchestrator depends on. Real adapters wrap @bureau/db, @bureau/vcs,
// and the WebSocket hub; tests inject fakes. This keeps Iris's logic — including
// the canPush security gate — fully unit-testable with no DB, git, or network.

import type { Task, TaskId } from "@bureau/core";
import type { WsEvent, Message } from "@bureau/contracts";

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
  /** Tear down a worktree (force = remove even if dirty, for aborts). */
  removeWorktree(ref: WorktreeRef, force: boolean): Promise<void>;
}

export interface EventSink {
  emit(event: WsEvent): void;
}

export interface MessageLog {
  append(message: Message): void;
  list(): Message[];
}
