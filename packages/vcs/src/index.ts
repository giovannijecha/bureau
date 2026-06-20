// @bureau/vcs — git/gh subprocess wrapper + worktree lifecycle.
// Imports @bureau/core only.
// Each repo gets one canonical clone; tasks get isolated git worktrees under it.

export {
  defaultRunner,
  makeRunner,
  run,
  withRetry,
  isTransient,
  assertSafeRef,
  assertSafeRepoUrl,
  assertSafeRepoId,
  parseGithubRepo,
  VcsError,
  type Runner,
  type ExecResult,
} from "./exec.js";
export * from "./worktree.js";
export * from "./git.js";
export * from "./git-admin.js";
