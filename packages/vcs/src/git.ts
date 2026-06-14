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

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * Bring the canonical clone's OWN working tree up to the latest origin base, so a
 * reader of it (Iris, in chat) sees the current repository — not a stale snapshot
 * from when it was cloned. Fetches origin/<baseBranch>, switches the clone to the
 * base branch, and hard-resets it to the fetched tip. Returns false (a no-op) when
 * offline / the ref doesn't resolve, so a transient network blip never breaks chat.
 *
 * SAFE w.r.t. running tasks: this touches ONLY the clone's main working tree, which
 * Bureau uses solely for reading + as the parent of task worktrees. Tasks run on
 * their own separate worktrees and branches (bureau/task-*), so nothing in flight
 * is disturbed; and the clone's main tree is never edited (edits are confined to
 * worktrees), so a hard reset discards nothing real.
 */
export async function syncToBase(
  clonePath: string,
  baseBranch: string,
  runner: Runner = defaultRunner
): Promise<boolean> {
  assertSafeRef(baseBranch, "base branch");
  const fetched = await runner("git", ["-C", clonePath, "fetch", "origin", baseBranch], {});
  if (fetched.code !== 0) return false; // offline / no remote — keep what we have
  const remoteRef = `origin/${baseBranch}`;
  const resolves = await runner("git", ["-C", clonePath, "rev-parse", "--verify", "--quiet", remoteRef], {});
  if (resolves.code !== 0) return false;
  const checkedOut = await runner("git", ["-C", clonePath, "checkout", baseBranch], {});
  if (checkedOut.code !== 0) return false;
  const reset = await runner("git", ["-C", clonePath, "reset", "--hard", remoteRef], {});
  return reset.code === 0;
}

/**
 * Refresh the base branch from origin and return the ref a new task branch should
 * be created from — `origin/<baseBranch>` when it resolves, so every task starts
 * off the LATEST main instead of the canonical clone's stale local copy. Without
 * this, a clone made before earlier tasks merged would branch off an old main and
 * force avoidable merge conflicts at confirm-merge time. Returns undefined (caller
 * falls back to the clone's HEAD) when the remote ref can't be fetched/resolved —
 * offline, no remote, or an empty repo — so worktree setup never hard-fails.
 */
export async function freshBase(
  clonePath: string,
  baseBranch: string,
  runner: Runner = defaultRunner
): Promise<string | undefined> {
  assertSafeRef(baseBranch, "base branch");
  const fetched = await runner("git", ["-C", clonePath, "fetch", "origin", baseBranch], {});
  if (fetched.code !== 0) return undefined; // offline / no remote — use the local HEAD
  const remoteRef = `origin/${baseBranch}`;
  const verify = await runner("git", ["-C", clonePath, "rev-parse", "--verify", "--quiet", remoteRef], {});
  return verify.code === 0 ? remoteRef : undefined;
}

/**
 * Stage everything and commit on the worktree's current branch. Returns true if
 * a commit was made, false if there was nothing to commit (a no-op edit) — the
 * empty-changeset case is benign, not an error. When `author` is given, the
 * identity is passed explicitly so the commit never depends on the machine's
 * global git config (which is absent on a fresh clone).
 */
export async function commitAll(
  worktreePath: string,
  message: string,
  runner: Runner = defaultRunner,
  author?: CommitAuthor
): Promise<boolean> {
  await run(runner, "git", ["-C", worktreePath, "add", "-A"]);
  // `diff --cached --quiet` exits 0 when nothing is staged, 1 when there are
  // staged changes — so we read the raw code rather than going through run().
  const staged = await runner("git", ["-C", worktreePath, "diff", "--cached", "--quiet"], {});
  if (staged.code === 0) return false; // clean — nothing to commit
  if (staged.code !== 1) {
    throw new VcsError(`\`git diff --cached --quiet\` failed (exit ${staged.code}): ${staged.stderr.trim()}`);
  }
  const identity = author
    ? ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`]
    : [];
  await run(runner, "git", ["-C", worktreePath, ...identity, "commit", "-m", message]);
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

// ── read-only repo inspection (the Git console) ──────────────────────────────
// These are best-effort + graceful: they read the raw exit code and return an
// empty result on failure rather than throwing, so a thin/edge-case repo (no
// commits yet, detached HEAD) renders an empty console instead of a 500.

export interface RepoCommit {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

/** Recent commits on the clone's current branch, newest first. */
export async function recentCommits(
  clonePath: string,
  limit: number,
  runner: Runner = defaultRunner
): Promise<RepoCommit[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  // \x1f separates fields, \x1e separates records — neither appears in commit text.
  const fmt = "%h%x1f%an%x1f%ad%x1f%s%x1e";
  const out = await runner("git", ["-C", clonePath, "log", "-n", String(n), "--date=short", `--pretty=format:${fmt}`], {});
  if (out.code !== 0) return [];
  return out.stdout
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash = "", author = "", date = "", subject = ""] = r.split("\x1f");
      return { hash, author, date, subject };
    });
}

/** The repo's branches as seen on origin (task worktree branches are excluded). */
export async function remoteBranches(
  clonePath: string,
  runner: Runner = defaultRunner
): Promise<string[]> {
  const out = await runner("git", ["-C", clonePath, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], {});
  if (out.code !== 0) return [];
  return out.stdout
    .split("\n")
    .map((s) => s.trim())
    // Drop the origin/HEAD symref (it shortens to "origin/HEAD" or bare "origin").
    .filter((b) => b && b !== "origin/HEAD" && b !== "origin")
    .map((b) => b.replace(/^origin\//, ""));
}

/** The clone's current branch, or null on a fresh/edge-case repo (best-effort). */
export async function headBranch(clonePath: string, runner: Runner = defaultRunner): Promise<string | null> {
  const out = await runner("git", ["-C", clonePath, "rev-parse", "--abbrev-ref", "HEAD"], {});
  return out.code === 0 ? out.stdout.trim() || null : null;
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

/**
 * The FULL change vs `base`, including uncommitted work — `git add -A` then
 * `git diff --cached <base>` (index vs base). Unlike getWorkingDiff (index vs
 * HEAD), this is correct for a reviewer running MID-pipeline after earlier steps
 * have already committed: it always shows the whole PR-shaped change from base,
 * on both the first run (nothing committed yet) and a re-run (v1 committed + v2
 * staged). `base` is a ref like "origin/main".
 */
export async function getReviewDiff(
  worktreePath: string,
  base: string,
  runner: Runner = defaultRunner
): Promise<string> {
  assertSafeRef(base, "review diff base");
  await run(runner, "git", ["-C", worktreePath, "add", "-A"]);
  return run(runner, "git", ["-C", worktreePath, "diff", "--cached", base]);
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

/**
 * Squash-merge the branch's PR into the base and delete the branch — the final,
 * human-confirmed step that lands the work on main and keeps the repo clean.
 * Call ONLY after canPush() === true (engine-gated). `ownerRepo` is "owner/repo".
 */
export async function mergePr(
  ownerRepo: string,
  branch: string,
  runner: Runner = defaultRunner
): Promise<void> {
  assertSafeRef(branch, "merge branch");
  await run(runner, "gh", [
    "pr",
    "merge",
    branch,
    "--repo",
    ownerRepo,
    "--squash",
    "--delete-branch",
  ]);
}
