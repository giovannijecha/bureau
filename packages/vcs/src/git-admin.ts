// CEO-AUTHORIZED git history/admin operations — squash, force-push, reset, branch &
// tag admin. These are the operations the normal task→diff→merge flow can't express.
//
// Branch/tag admin MIRRORS TO ORIGIN: creating, renaming, or deleting a branch (and
// creating a tag) also pushes that change to GitHub — so a branch the CEO makes is a
// REAL branch on GitHub (visible there, and to Iris next turn via the origin refs), not
// an invisible local-only pointer. reset_hard stays local (it's a local working-tree op).
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

import { defaultRunner, run, assertSafeRef, VcsError, type Runner } from "./exec.js";

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

/**
 * Create a branch (optionally off `base`) and PUSH it to origin, so it lands on GitHub
 * and is visible to Iris next turn. Atomic: if the push fails, the just-created local
 * branch is dropped so nothing is left half-done. Safe (non-destructive on the remote —
 * it only adds a new branch).
 */
export async function createBranch(repoPath: string, name: string, base: string | undefined, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(name, "branch name");
  if (base !== undefined) assertSafeRef(base, "base ref");
  // Idempotent + forgiving: if the branch already exists LOCALLY (e.g. made before branch
  // ops pushed to origin), don't error — just publish it. Otherwise create it, then push.
  const exists = await runner("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], {});
  const created = exists.code !== 0;
  if (created) {
    await run(runner, "git", base !== undefined ? ["-C", repoPath, "branch", name, base] : ["-C", repoPath, "branch", name]);
  }
  const pushed = await runner("git", ["-C", repoPath, "push", "-u", "origin", name], {});
  if (pushed.code !== 0) {
    if (created) await runner("git", ["-C", repoPath, "branch", "-D", name], {}); // undo only what WE created
    throw new VcsError(`Couldn't push "${name}" to origin: ${pushed.stderr.trim() || "push failed"}`);
  }
}

/** Rename a branch and mirror the rename on origin (push the new name, delete the old).
 *  The remote half is best-effort — the branch may have existed only locally. Safe. */
export async function renameBranch(repoPath: string, from: string, to: string, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(from, "from branch");
  assertSafeRef(to, "to branch");
  await run(runner, "git", ["-C", repoPath, "branch", "-m", from, to]);
  await runner("git", ["-C", repoPath, "push", "-u", "origin", to], {});
  await runner("git", ["-C", repoPath, "push", "origin", "--delete", from], {});
}

/** Delete a branch locally AND on origin. DESTRUCTIVE. The remote delete is best-effort
 *  (the branch may have existed only locally). git refuses to delete the checked-out branch. */
export async function deleteLocalBranch(repoPath: string, branch: string, runner: Runner = defaultRunner): Promise<void> {
  assertSafeRef(branch, "branch");
  await run(runner, "git", ["-C", repoPath, "branch", "-D", branch]);
  await runner("git", ["-C", repoPath, "push", "origin", "--delete", branch], {});
}

/** Create a tag — annotated (needs identity) when a message is given, else lightweight —
 *  and push it to origin (best-effort) so it appears on GitHub. Safe. */
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
  await runner("git", ["-C", repoPath, "push", "origin", name], {});
}

/** Fetch + prune from origin. Safe. */
export async function fetchOrigin(repoPath: string, runner: Runner = defaultRunner): Promise<void> {
  await run(runner, "git", ["-C", repoPath, "fetch", "--prune", "origin"]);
}
