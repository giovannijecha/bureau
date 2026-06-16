// CEO-AUTHORIZED git history/admin operations — squash, force-push, reset, branch &
// tag admin. These are the operations the normal task→diff→merge flow can't express.
//
// SAFETY (every op):
//  • argv-only (spawn, no shell) — shell metacharacters are inert.
//  • every ref/branch/tag/name is validated by assertSafeRef → must start with an
//    alphanumeric (no leading "-"), so a branch literally named "--force" can never be
//    smuggled in as a git FLAG (the residual argument-injection hole).
//  • author identity is passed ONLY to operations that create a commit (squash, an
//    annotated tag) — never to push/branch/delete/fetch, which don't commit.
//  • force-push uses --force-with-lease (refuses if origin moved since), never --force.
// The engine is responsible for the human gate (type-to-confirm for destructive ops);
// these functions just execute the already-authorized operation.

import { defaultRunner, run, assertSafeRef, type Runner } from "./exec.js";

/** Git author identity — supplied ONLY for operations that create a commit. */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

const idArgs = (id: GitIdentity): string[] => ["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`];

/**
 * Squash a branch's ENTIRE history into ONE commit holding the current tree, then
 * force-push it (with-lease). Uses an orphan branch so it works with no common base
 * (mirrors the manual `checkout --orphan` flow, but with identity configured so it
 * never fails on "Author identity unknown"). DESTRUCTIVE — rewrites shared history.
 */
export async function squashAllAndForcePush(
  repoPath: string,
  branch: string,
  message: string,
  id: GitIdentity,
  runner: Runner = defaultRunner
): Promise<void> {
  assertSafeRef(branch, "branch");
  const tmp = "bureau-squash-tmp";
  await run(runner, "git", ["-C", repoPath, "checkout", "--orphan", tmp]);
  await run(runner, "git", ["-C", repoPath, "add", "-A"]);
  await run(runner, "git", ["-C", repoPath, ...idArgs(id), "commit", "-m", message]);
  // Replace the target branch with the single-commit one, then publish it.
  await run(runner, "git", ["-C", repoPath, "branch", "-D", branch]);
  await run(runner, "git", ["-C", repoPath, "branch", "-m", branch]);
  await run(runner, "git", ["-C", repoPath, "push", "--force-with-lease", "origin", branch]);
}

/** Force-push a branch to origin (with-lease — refuses if the remote moved). DESTRUCTIVE. */
export async function forcePushWithLease(repoPath: string, branch: string, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(branch, "branch");
  await run(runner, "git", ["-C", repoPath, "push", "--force-with-lease", "origin", branch]);
}

/** Hard-reset the working branch to `ref` (e.g. origin/main). DESTRUCTIVE (local only). */
export async function resetHardTo(repoPath: string, ref: string, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(ref, "ref");
  await run(runner, "git", ["-C", repoPath, "reset", "--hard", ref]);
}

/** Create a new branch (optionally off `base`). Safe. */
export async function createBranch(repoPath: string, name: string, base: string | undefined, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(name, "branch name");
  if (base !== undefined) assertSafeRef(base, "base ref");
  await run(runner, "git", base !== undefined ? ["-C", repoPath, "branch", name, base] : ["-C", repoPath, "branch", name]);
}

/** Rename a branch. Safe. */
export async function renameBranch(repoPath: string, from: string, to: string, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(from, "from branch");
  assertSafeRef(to, "to branch");
  await run(runner, "git", ["-C", repoPath, "branch", "-m", from, to]);
}

/** Delete a LOCAL branch. DESTRUCTIVE. (git refuses to delete the checked-out branch.) */
export async function deleteLocalBranch(repoPath: string, branch: string, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(branch, "branch");
  await run(runner, "git", ["-C", repoPath, "branch", "-D", branch]);
}

/** Create a tag — annotated (needs identity) when a message is given, else lightweight. Safe. */
export async function createTag(
  repoPath: string,
  name: string,
  message: string | undefined,
  id: GitIdentity,
  runner: Runner = defaultRunner
): Promise<void> {
  assertSafeRef(name, "tag name");
  await run(
    runner,
    "git",
    message !== undefined && message.trim() !== ""
      ? ["-C", repoPath, ...idArgs(id), "tag", "-a", name, "-m", message]
      : ["-C", repoPath, "tag", name]
  );
}

/** Fetch + prune from origin. Safe. */
export async function fetchOrigin(repoPath: string, runner: Runner = defaultRunner): Promise<void> {
  await run(runner, "git", ["-C", repoPath, "fetch", "--prune", "origin"]);
}
