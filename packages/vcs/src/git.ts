// git/gh subprocess helpers.
//
// SAFETY — the canPush gate: push() and openPr() MUST only be called after
// core.canPush() === true. DELIBERATE DESIGN DECISION: this module does NOT
// re-check that. canPush is THE security wall and lives in exactly one place
// (@bureau/core), enforced by the engine, which has tests proving push/openPr
// never run unless canPush()===true. A second gate here would dilute "the only
// gate" invariant, so these wrappers stay dumb on purpose.
//
// Injection safety: every caller-supplied positional sits behind a `--`
// end-of-options separator, and every git ref is validated by assertSafeRef —
// so neither a path nor a ref beginning with "-" can be parsed as a flag.

import { existsSync, readdirSync } from "node:fs";
import { defaultRunner, run, assertSafeRef, VcsError, type Runner } from "./exec.js";

/**
 * Clone a repository into destPath. `source` is anything `git clone` accepts —
 * an https URL, an ssh URL, or a local path (tests). Refuses a destination that
 * already exists and is non-empty so the engine can decide reuse vs. fail.
 */
export async function cloneRepo(
  source: string,
  destPath: string,
  runner: Runner = defaultRunner
): Promise<void> {
  if (existsSync(destPath) && readdirSync(destPath).length > 0) {
    throw new VcsError(`Clone destination "${destPath}" already exists and is not empty.`);
  }
  await run(runner, "git", ["clone", "--", source, destPath]);
}

/**
 * Stage everything and commit on the worktree's current branch. Returns true if
 * a commit was made, false if there was nothing to commit (a no-op edit) — the
 * empty-changeset case is benign, not an error.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
  runner: Runner = defaultRunner
): Promise<boolean> {
  await run(runner, "git", ["-C", worktreePath, "add", "-A"]);
  // `diff --cached --quiet` exits 0 when nothing is staged, 1 when there are
  // staged changes — so we read the raw code rather than going through run().
  const staged = await runner("git", ["-C", worktreePath, "diff", "--cached", "--quiet"], {});
  if (staged.code === 0) return false; // clean — nothing to commit
  if (staged.code !== 1) {
    throw new VcsError(`\`git diff --cached --quiet\` failed (exit ${staged.code}): ${staged.stderr.trim()}`);
  }
  await run(runner, "git", ["-C", worktreePath, "commit", "-m", message]);
  return true;
}

/** The worktree's current branch name. */
export async function currentBranch(
  worktreePath: string,
  runner: Runner = defaultRunner
): Promise<string> {
  const out = await run(runner, "git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}

/**
 * The committed diff of the worktree branch against `base` (e.g. "main") — the
 * change a PR would introduce. Validates the base and verifies it resolves, so
 * a missing/typo base yields a clear error instead of git's "ambiguous argument".
 */
export async function getDiff(
  worktreePath: string,
  base: string,
  runner: Runner = defaultRunner
): Promise<string> {
  assertSafeRef(base, "diff base");
  const verify = await runner("git", ["-C", worktreePath, "rev-parse", "--verify", "--quiet", base], {});
  if (verify.code !== 0) {
    throw new VcsError(`Diff base ref "${base}" was not found in worktree ${worktreePath}.`);
  }
  return run(runner, "git", ["-C", worktreePath, "diff", `${base}...HEAD`]);
}

/**
 * The uncommitted working-tree diff, including new (untracked) files. Stages
 * everything first (`git add -A`) so untracked files appear as additions — a
 * task worktree is about to be committed anyway.
 */
export async function getWorkingDiff(
  worktreePath: string,
  runner: Runner = defaultRunner
): Promise<string> {
  await run(runner, "git", ["-C", worktreePath, "add", "-A"]);
  return run(runner, "git", ["-C", worktreePath, "diff", "--cached"]);
}

/** Push the branch to origin. Call ONLY after canPush() === true (engine-gated). */
export async function push(
  worktreePath: string,
  branch: string,
  runner: Runner = defaultRunner
): Promise<void> {
  assertSafeRef(branch, "push branch");
  await run(runner, "git", ["-C", worktreePath, "push", "-u", "origin", branch]);
}

/**
 * Open a PR via `gh` and return its URL. Call ONLY after canPush() === true
 * (engine-gated). `ownerRepo` is "owner/repo".
 */
export async function openPr(
  ownerRepo: string,
  branch: string,
  title: string,
  body: string,
  runner: Runner = defaultRunner
): Promise<string> {
  assertSafeRef(branch, "PR head branch");
  const out = await run(runner, "gh", [
    "pr",
    "create",
    "--repo",
    ownerRepo,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  return out.trim(); // gh prints the new PR URL on stdout
}
