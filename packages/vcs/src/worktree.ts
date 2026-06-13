// Worktree lifecycle — create / remove isolated git worktrees per task.
// Each repo has one canonical clone; every task runs in its own worktree +
// branch under that clone, so concurrent tasks never touch each other's files.

import { defaultRunner, run, assertSafeRef, type Runner } from "./exec.js";

export interface WorktreeHandle {
  readonly path: string;
  readonly branch: string;
  /** The canonical clone this worktree belongs to (needed to remove it). */
  readonly repoPath: string;
}

/** Create a new isolated worktree on a fresh branch off the clone's current HEAD. */
export async function createWorktree(
  canonicalClonePath: string,
  branch: string,
  worktreePath: string,
  runner: Runner = defaultRunner
): Promise<WorktreeHandle> {
  assertSafeRef(branch, "branch");
  await run(runner, "git", ["-C", canonicalClonePath, "worktree", "add", "-b", branch, "--", worktreePath]);
  return { path: worktreePath, branch, repoPath: canonicalClonePath };
}

/**
 * Remove a worktree (and prune its admin entry) when a task is done or aborted.
 * Pass `{ force: true }` for the abort/cleanup path — a rejected task's worktree
 * still has the capability's uncommitted edits, and git refuses to remove a
 * dirty worktree without --force.
 */
export async function removeWorktree(
  handle: WorktreeHandle,
  opts?: { force?: boolean },
  runner: Runner = defaultRunner
): Promise<void> {
  const args = ["-C", handle.repoPath, "worktree", "remove"];
  if (opts?.force) args.push("--force");
  args.push("--", handle.path);
  await run(runner, "git", args);
}
