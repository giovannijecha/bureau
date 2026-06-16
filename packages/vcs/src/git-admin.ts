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
 * Squash a branch's ENTIRE history into ONE root commit holding THAT branch's current
 * tree, then force-push it (with-lease). DESTRUCTIVE — rewrites shared history.
 *
 * Built on plumbing (`commit-tree` of `<branch>^{tree}`) rather than a working-tree
 * checkout + temp branch, which makes it:
 *   • correct regardless of which branch the clone has checked out — it always squashes
 *     the NAMED branch's tree, never "whatever HEAD happens to point at" (the clone is
 *     normally parked on the base branch by syncToBase, so a checkout-based squash of a
 *     different branch would silently publish the wrong tree);
 *   • idempotent — no temp branch is created, so a failed run can't strand a
 *     `bureau-squash-tmp` ref that would wedge every later squash;
 *   • worktree-safe — it mutates the working tree only when the named branch IS the
 *     clone's checked-out HEAD (then a tree-identical `reset --hard` just moves the ref);
 *     if another worktree pins the branch, `branch -f` fails closed (clear error, no
 *     data loss).
 * An empty repo (e.g. after a "delete all files" task) resolves to git's empty-tree
 * object → a single empty root commit, never "nothing to commit". Identity is passed via
 * -c so commit-tree never dies on "identity unknown" on a fresh clone.
 */
export async function squashAllAndForcePush(
  repoPath: string,
  branch: string,
  message: string,
  id: GitIdentity,
  runner: Runner = defaultRunner
): Promise<void> {
  assertSafeRef(branch, "branch");
  // The named branch's current tree (raw exit code — `run` would throw on a missing ref).
  const treeRes = await runner("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${branch}^{tree}`], {});
  const tree = treeRes.stdout.trim();
  if (treeRes.code !== 0 || !tree) throw new VcsError(`Squash target branch "${branch}" was not found`);
  // A brand-new ROOT commit (no -p parent) holding exactly that tree → all history collapses.
  const commit = (await run(runner, "git", ["-C", repoPath, ...idArgs(id), "commit-tree", tree, "-m", message])).trim();
  // Point the branch at the single commit. If it's the clone's checked-out HEAD, reset
  // --hard so HEAD/index/worktree follow (no file change — same tree); else move the ref.
  const head = (await runner("git", ["-C", repoPath, "symbolic-ref", "--quiet", "HEAD"], {})).stdout.trim();
  if (head === `refs/heads/${branch}`) {
    await run(runner, "git", ["-C", repoPath, "reset", "--hard", commit]);
  } else {
    await run(runner, "git", ["-C", repoPath, "branch", "-f", branch, commit]);
  }
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
