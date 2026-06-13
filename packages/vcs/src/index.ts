// @bureau/vcs — git/gh subprocess wrapper + worktree lifecycle.
// Imports @bureau/core only.
// Each repo gets one canonical clone; tasks get isolated git worktrees under it.

export * from "./worktree.js";
export * from "./git.js";
