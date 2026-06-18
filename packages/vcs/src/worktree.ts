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

/**
 * Create a new isolated worktree on a fresh branch. Branches off `base` (a git
 * ref, e.g. "origin/main") when given — so a task starts from the latest base
 * rather than the clone's possibly-stale HEAD — otherwise off the clone's current
 * HEAD. The worktree path stays behind `--`; an explicit base ref is validated
 * and sits after the path, where `worktree add` reads its optional commit-ish.
 */
export async function createWorktree(
  canonicalClonePath: string,
  branch: string,
  worktreePath: string,
  runner: Runner = defaultRunner,
  base?: string
): Promise<WorktreeHandle> {
  assertSafeRef(branch, "branch");
  if (base !== undefined) assertSafeRef(base, "worktree base");
  const args = ["-C", canonicalClonePath, "worktree", "add", "-b", branch, "--", worktreePath];
  if (base !== undefined) args.push(base);
  await run(runner, "git", args);
  return { path: worktreePath, branch, repoPath: canonicalClonePath };
}

/**
 * Drop stale worktree admin entries (`.git/worktrees/*`) whose on-disk path no longer
 * exists — so re-creating a worktree at a path a crash half-tore-down doesn't fail with
 * "already registered". Best-effort, idempotent. Operates on the canonical clone.
 */
export async function pruneWorktrees(canonicalClonePath: string, runner: Runner = defaultRunner): Promise<void> {
  await run(runner, "git", ["-C", canonicalClonePath, "worktree", "prune"]);
}

/**
 * Hard-reset an EXISTING worktree to `base` (a validated ref, e.g. "origin/main") and
 * remove untracked files — discarding any uncommitted/partial work a crash left behind, so
 * a resumed task re-runs from a pristine tree. `clean -fd` (NOT `-fdx`) keeps .gitignored
 * build dirs (node_modules/dist/.next), removing only untracked, non-ignored crash debris.
 * LOCAL only (reset/clean) — never reaches a remote.
 */
export async function resetWorktreeToBase(
  worktreePath: string,
  base: string,
  runner: Runner = defaultRunner
): Promise<void> {
  assertSafeRef(base, "reset base");
  await run(runner, "git", ["-C", worktreePath, "reset", "--hard", base]);
  await run(runner, "git", ["-C", worktreePath, "clean", "-fd"]);
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
