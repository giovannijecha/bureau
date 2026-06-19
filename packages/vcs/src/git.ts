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

/** True when the repo has no commits yet — an "unborn HEAD" (a freshly created repo, or
 *  one cloned from an empty remote). `git rev-parse --verify --quiet HEAD` exits non-zero
 *  in that state. The read-only browser checks this so it shows an empty state instead of
 *  letting `ls-tree <baseBranch>` fail with exit 128 ("Not a valid object name"). */
export async function hasNoCommits(clonePath: string, runner: Runner = defaultRunner): Promise<boolean> {
  const out = await runner("git", ["-C", clonePath, "rev-parse", "--verify", "--quiet", "HEAD"], {});
  return out.code !== 0;
}

/** The clone's LOCAL branches (refs/heads). Lets Iris see branches that exist locally
 *  but aren't pushed to origin yet — so she never claims a real local branch "doesn't
 *  exist" just because it isn't on GitHub. Best-effort (empty on a fresh/edge-case repo). */
export async function localBranches(clonePath: string, runner: Runner = defaultRunner): Promise<string[]> {
  const out = await runner("git", ["-C", clonePath, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {});
  if (out.code !== 0) return [];
  return out.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Branch names under a ref namespace (e.g. "refs/heads", "refs/remotes/origin"). */
async function refsUnder(clonePath: string, namespace: string, runner: Runner): Promise<string[]> {
  const out = await runner("git", ["-C", clonePath, "for-each-ref", "--format=%(refname:short)", namespace], {});
  if (out.code !== 0) return [];
  return out.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Each existing worktree's path → its checked-out branch (short name), parsed from
 *  `git worktree list --porcelain`. A detached / bare entry has branch === null. */
async function worktreeBranches(clonePath: string, runner: Runner): Promise<{ path: string; branch: string | null }[]> {
  const out = await runner("git", ["-C", clonePath, "worktree", "list", "--porcelain"], {});
  if (out.code !== 0) return [];
  const entries: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), branch: null };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** Only Bureau's own task branches are ever deletable — never main or a user branch. */
const TASK_BRANCH = /^bureau\/task-[A-Za-z0-9._-]+$/;

/**
 * Delete every `bureau/task-*` branch (local + on origin) EXCEPT those in `keep`.
 * HARD-CONSTRAINED to the `bureau/task-*` namespace so this can NEVER remove main,
 * a release branch, or any user branch — it's Bureau's own worktree-branch hygiene,
 * distinct from the code-merge security wall. Best-effort per branch (a branch may
 * exist only locally or only on the remote); returns the branches actually removed.
 */
export async function pruneTaskBranches(
  clonePath: string,
  keep: readonly string[],
  runner: Runner = defaultRunner
): Promise<string[]> {
  const keepSet = new Set(keep);

  // Release any leftover worktree pinning a prunable task branch FIRST. git refuses to
  // delete a branch checked out in a worktree, so an orphan worktree from a deleted or
  // crashed task — its task gone from the store, yet its worktree still on disk — would
  // otherwise keep its branch un-prunable forever, and "Clean up branches" would
  // silently leave it behind. Only bureau/task-* worktrees NOT in `keep` are removed:
  // an in-flight task's worktree (its branch is in `keep`) and the main worktree (never
  // a bureau/task-* branch) are never touched. Best-effort — a remove that fails just
  // leaves its branch un-deletable below, the same as before.
  await runner("git", ["-C", clonePath, "worktree", "prune"], {}); // drop stale admin entries first
  for (const wt of await worktreeBranches(clonePath, runner)) {
    if (wt.branch !== null && TASK_BRANCH.test(wt.branch) && !keepSet.has(wt.branch)) {
      await runner("git", ["-C", clonePath, "worktree", "remove", "--force", "--", wt.path], {});
    }
  }

  const local = await refsUnder(clonePath, "refs/heads", runner);
  const remote = (await refsUnder(clonePath, "refs/remotes/origin", runner)).map((b) => b.replace(/^origin\//, ""));
  const candidates = [...new Set([...local, ...remote])].filter((b) => TASK_BRANCH.test(b) && !keepSet.has(b));

  const deleted: string[] = [];
  for (const b of candidates) {
    if (!TASK_BRANCH.test(b)) continue; // belt-and-suspenders — never touch a non-task ref
    const localDel = await runner("git", ["-C", clonePath, "branch", "-D", b], {});
    const remoteDel = await runner("git", ["-C", clonePath, "push", "origin", "--delete", b], {});
    if (localDel.code === 0 || remoteDel.code === 0) deleted.push(b);
  }
  return deleted;
}

/**
 * Delete ONE `bureau/task-*` branch (local + on origin). HARD-CONSTRAINED to the
 * task namespace — refuses any other ref (main, a release/user branch) so the CEO's
 * per-branch cleanup can never remove anything but Bureau's own worktree branches.
 * Returns true if it removed the branch from either local or origin.
 */
export async function deleteTaskBranch(clonePath: string, branch: string, runner: Runner = defaultRunner): Promise<boolean> {
  if (!TASK_BRANCH.test(branch)) {
    throw new VcsError(`Refusing to delete "${branch}": only bureau/task-* branches are deletable.`);
  }
  const localDel = await runner("git", ["-C", clonePath, "branch", "-D", branch], {});
  const remoteDel = await runner("git", ["-C", clonePath, "push", "origin", "--delete", branch], {});
  return localDel.code === 0 || remoteDel.code === 0;
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

/** Does origin have the base branch? Queries the REMOTE directly (`git ls-remote
 *  --exit-code --heads origin <base>`), so it's correct even when the local clone is
 *  stale or was cloned while the repo was empty. false ⇒ a brand-new repo with no base
 *  to open a PR against — the first task must ESTABLISH the base instead. */
export async function baseExists(
  clonePath: string,
  baseBranch: string,
  runner: Runner = defaultRunner
): Promise<boolean> {
  assertSafeRef(baseBranch, "base branch");
  const out = await runner("git", ["-C", clonePath, "ls-remote", "--exit-code", "--heads", "origin", baseBranch], {});
  return out.code === 0; // 0 = ref present; 2 = absent; other = transient (treated as absent → safe establish/PR retry)
}

/** Create the base branch on origin from `srcRef` — the FIRST task on an empty repo, where
 *  there's no base to open a PR against, so the branch's content IS the initial main. Pushes
 *  `srcRef:refs/heads/<baseBranch>` (NO --force, so an existing main can never be clobbered —
 *  git rejects a non-fast-forward, which correctly routes the caller back to the PR path).
 *  `srcRef` is a local branch (from a worktree) or `origin/<branch>` (from the clone, on
 *  recovery). argv-only; both refs validated SEPARATELY, then the refspec is assembled here
 *  (assertSafeRef rejects the `:` in a refspec, so it can never be validated whole). */
export async function establishBase(
  gitDir: string,
  srcRef: string,
  baseBranch: string,
  runner: Runner = defaultRunner
): Promise<void> {
  assertSafeRef(srcRef, "establish-base source ref");
  assertSafeRef(baseBranch, "establish-base target branch");
  await run(runner, "git", ["-C", gitDir, "push", "origin", `${srcRef}:refs/heads/${baseBranch}`]);
}

// ── Read-only codebase browser (the embedded-GitHub Git page) ───────────────────

/** A repo-relative path, sanitized to stay inside the tree (no "..", no leading "-",
 *  no absolute) — for the read-only browser. Returns "" for the repo root. */
function sanitizeTreePath(p: string): string {
  const t = (p ?? "").replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").trim();
  if (t === "") return "";
  if (!/^[A-Za-z0-9._/-]+$/.test(t) || t.split("/").some((s) => s === "" || s === ".." || s.startsWith("-"))) {
    throw new VcsError(`Unsafe path "${p}".`);
  }
  return t;
}

export interface TreeEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "blob" | "tree";
}

/** One directory level of the tree at `ref` (git ls-tree, NOT recursive). Read-only;
 *  ref + path validated; argv-only. `-z` ⇒ NUL-delimited records with paths emitted
 *  VERBATIM (git's default C-quoting of non-ASCII names is disabled), so a Unicode or
 *  spaced filename stays a real, clickable path. Dirs first, then files, alphabetical. */
export async function listTree(repoPath: string, ref: string, dir: string, runner: Runner = defaultRunner): Promise<TreeEntry[]> {
  assertSafeRef(ref, "ref");
  const cleanDir = sanitizeTreePath(dir);
  const args = ["-C", repoPath, "ls-tree", "-z", ref];
  if (cleanDir !== "") args.push("--", `${cleanDir}/`);
  const out = await run(runner, "git", args);
  const entries: TreeEntry[] = [];
  for (const rec of out.split("\0")) {
    // `<mode> <type> <sha>\t<path>` — path may contain spaces/newlines, so match it greedily.
    const m = /^\d+ (blob|tree) [0-9a-f]+\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const full = m[2]!;
    entries.push({ name: full.split("/").pop() || full, path: full, type: m[1] === "tree" ? "tree" : "blob" });
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === "tree" ? -1 : 1) : a.name.localeCompare(b.name)));
  return entries;
}

/** A file's content at `ref` (git show ref:path), capped. Read-only; validated. */
export async function showFile(
  repoPath: string,
  ref: string,
  filePath: string,
  runner: Runner = defaultRunner
): Promise<{ content: string; truncated: boolean }> {
  assertSafeRef(ref, "ref");
  const clean = sanitizeTreePath(filePath);
  if (clean === "") throw new VcsError("No file path given.");
  const result = await runner("git", ["-C", repoPath, "show", `${ref}:${clean}`], {});
  if (result.code !== 0) throw new VcsError(`Could not read "${clean}" at ${ref}: ${result.stderr.trim() || "not found"}`);
  const CAP = 700_000;
  if (result.stdout.length <= CAP) return { content: result.stdout, truncated: false };
  // Cut at the last newline before the cap so the tail isn't a half-line / split surrogate.
  const cut = result.stdout.lastIndexOf("\n", CAP);
  return { content: result.stdout.slice(0, cut > 0 ? cut : CAP), truncated: true };
}

export interface EntryCommit {
  readonly path: string;
  readonly hash: string;
  readonly subject: string;
  readonly date: string; // committer date, strict ISO (for relative-time formatting)
}

/**
 * The most-recent commit that touched each entry of `dir` at `ref` — the GitHub-style
 * "latest commit per file" column. Read-only; `ref` validated; every path sits behind
 * a `--` so a "-"-leading filename can't be read as a flag. Bounded concurrency keeps a
 * wide directory from spawning hundreds of git processes; an entry with no resolvable
 * history is simply omitted. Loaded SEPARATELY from listTree so the tree renders instantly
 * (GitHub fills the commit column progressively for the same reason).
 */
export async function treeLastCommits(
  repoPath: string,
  ref: string,
  dir: string,
  runner: Runner = defaultRunner
): Promise<EntryCommit[]> {
  assertSafeRef(ref, "ref");
  // Cap the entries we resolve commits for: each is its own `git log -1` subprocess, so
  // a directory with thousands of entries (vendored deps, generated output) would spawn
  // thousands of processes per view. Like GitHub, fill the column only up to a bound and
  // leave the rest blank — the file LIST itself (listTree) is unbounded and renders fully.
  const MAX_ENTRIES = 300;
  const entries = (await listTree(repoPath, ref, dir, runner)).slice(0, MAX_ENTRIES);
  const out: EntryCommit[] = [];
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < entries.length) {
      const e = entries[i++]!;
      const r = await runner("git", ["-C", repoPath, "log", "-1", "--format=%h%x1f%s%x1f%cI", ref, "--", e.path], {});
      if (r.code !== 0) continue;
      const [hash = "", subject = "", date = ""] = r.stdout.trim().split("\x1f");
      if (hash && date) out.push({ path: e.path, hash, subject, date }); // need a date for relative-time
    }
  };
  const CONCURRENCY = 12;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()));
  return out;
}

/**
 * Every file path in the repo at `ref` (recursive) — the data behind the "go to file"
 * finder. Read-only; `ref` validated. Capped so a huge monorepo can't flood the client;
 * `truncated` flags when the list was cut.
 */
export async function listAllFiles(
  repoPath: string,
  ref: string,
  runner: Runner = defaultRunner
): Promise<{ paths: string[]; truncated: boolean }> {
  assertSafeRef(ref, "ref");
  // `-z` ⇒ NUL-delimited + paths VERBATIM (no C-quoting), so a Unicode/spaced filename is
  // a real path the finder can open. Don't trim — a NUL field is already exact.
  const out = await runner("git", ["-C", repoPath, "ls-tree", "-r", "--name-only", "-z", ref], {});
  if (out.code !== 0) return { paths: [], truncated: false };
  const all = out.stdout.split("\0").filter(Boolean);
  const CAP = 20_000;
  return all.length > CAP ? { paths: all.slice(0, CAP), truncated: true } : { paths: all, truncated: false };
}

/** Commits that touched `filePath`, newest first (file history). Read-only; `ref`
 *  validated, path sanitized, path behind `--`. Empty on an untracked/edge-case path. */
export async function fileHistory(
  repoPath: string,
  ref: string,
  filePath: string,
  limit: number,
  runner: Runner = defaultRunner
): Promise<RepoCommit[]> {
  assertSafeRef(ref, "ref");
  const clean = sanitizeTreePath(filePath);
  if (clean === "") throw new VcsError("No file path given.");
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const fmt = "%h%x1f%an%x1f%ad%x1f%s%x1e";
  const out = await runner("git", ["-C", repoPath, "log", "-n", String(n), "--date=short", `--pretty=format:${fmt}`, ref, "--", clean], {});
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

export interface CommitFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export interface CommitDetail {
  readonly hash: string;
  readonly author: string;
  readonly date: string; // committer date, strict ISO
  readonly subject: string;
  readonly body: string;
  readonly files: readonly CommitFile[];
  readonly patch: string;
  readonly truncated: boolean;
}

/**
 * One commit's metadata, per-file stats, and full patch (capped) — the diff viewer
 * behind the Commits tab + file history. Read-only; `ref` validated; argv-only.
 * Returns null when `ref` doesn't resolve. Three cheap `git show` calls (meta /
 * numstat / patch) — run only when the CEO clicks a single commit.
 */
export async function showCommit(repoPath: string, ref: string, runner: Runner = defaultRunner): Promise<CommitDetail | null> {
  assertSafeRef(ref, "commit ref");
  const meta = await runner("git", ["-C", repoPath, "show", "-s", "--format=%H%x1f%an%x1f%cI%x1f%s%x1f%b", ref], {});
  if (meta.code !== 0) return null;
  const [hash = "", author = "", date = "", subject = "", ...rest] = meta.stdout.trim().split("\x1f");
  const body = rest.join("\x1f").trim();
  // `--numstat -z`: NUL-delimited, paths verbatim (no quoting). A stat token is
  // "additions \t deletions \t [path]"; "-" in either column ⇒ binary. On a RENAME the
  // path field is EMPTY and the next two NUL fields are the old then the NEW path — so
  // we read the new path instead of the literal "old => new" arrow string.
  const stat = await runner("git", ["-C", repoPath, "show", ref, "--format=", "--numstat", "-z"], {});
  const files: CommitFile[] = [];
  if (stat.code === 0) {
    const tokens = stat.stdout.split("\0");
    let i = 0;
    while (i < tokens.length) {
      const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(tokens[i] ?? "");
      if (!m) {
        i++;
        continue;
      }
      const binary = m[1] === "-" || m[2] === "-";
      let p = m[3]!;
      if (p === "") {
        p = tokens[i + 2] ?? tokens[i + 1] ?? ""; // rename: old, NEW
        i += 3;
      } else {
        i += 1;
      }
      if (p) files.push({ path: p, additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
    }
  }
  const patchRes = await runner("git", ["-C", repoPath, "show", ref, "--format=", "--patch"], {});
  const raw = patchRes.code === 0 ? patchRes.stdout : "";
  const CAP = 400_000;
  if (raw.length <= CAP) return { hash: hash || ref, author, date, subject, body, files, patch: raw, truncated: false };
  // Cut at the last newline before the cap so the final hunk/line isn't sheared mid-token.
  const cut = raw.lastIndexOf("\n", CAP);
  return { hash: hash || ref, author, date, subject, body, files, patch: raw.slice(0, cut > 0 ? cut : CAP), truncated: true };
}

/** The GitHub account `gh` is authenticated as (read-only), or null if not signed in.
 *  Reuses the existing `gh` auth — no OAuth, no stored token. */
export async function ghAccount(runner: Runner = defaultRunner): Promise<{ login: string; name: string | null } | null> {
  const result = await runner("gh", ["api", "user"], {});
  if (result.code !== 0) return null;
  try {
    const u = JSON.parse(result.stdout) as { login?: string; name?: string | null };
    return u.login ? { login: u.login, name: u.name ?? null } : null;
  } catch {
    return null;
  }
}

export interface PrInfo {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly state: string;
  readonly url: string;
  readonly draft: boolean;
}

/** Read-only list of the repo's pull requests via `gh pr list --json`. Returns []
 *  (never throws) if gh isn't authenticated or the repo has none. `ownerRepo` is "owner/repo". */
export async function prList(ownerRepo: string, runner: Runner = defaultRunner): Promise<PrInfo[]> {
  const result = await runner("gh", ["pr", "list", "--repo", ownerRepo, "--state", "all", "--limit", "50", "--json", "number,title,author,state,url,isDraft"], {});
  if (result.code !== 0) return [];
  try {
    const arr = JSON.parse(result.stdout) as { number: number; title: string; author?: { login?: string }; state: string; url: string; isDraft?: boolean }[];
    return arr.map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? "", state: p.state.toLowerCase(), url: p.url, draft: p.isDraft ?? false }));
  } catch {
    return [];
  }
}

export interface IssueInfo {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly state: string;
  readonly url: string;
}

/** Read-only list of the repo's issues via `gh issue list --json`. Returns [] (never
 *  throws) if gh isn't authenticated or issues are disabled/none. */
export async function issueList(ownerRepo: string, runner: Runner = defaultRunner): Promise<IssueInfo[]> {
  const result = await runner("gh", ["issue", "list", "--repo", ownerRepo, "--state", "all", "--limit", "50", "--json", "number,title,author,state,url"], {});
  if (result.code !== 0) return [];
  try {
    const arr = JSON.parse(result.stdout) as { number: number; title: string; author?: { login?: string }; state: string; url: string }[];
    return arr.map((i) => ({ number: i.number, title: i.title, author: i.author?.login ?? "", state: i.state.toLowerCase(), url: i.url }));
  } catch {
    return [];
  }
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
  baseBranch: string,
  runner: Runner = defaultRunner
): Promise<string> {
  assertSafeRef(branch, "PR head branch");
  assertSafeRef(baseBranch, "PR base branch");
  const out = await run(runner, "gh", [
    "pr",
    "create",
    "--repo",
    ownerRepo,
    // Pin the base explicitly — never rely on gh's default-branch guess (which is blank
    // on an empty repo → "can't be blank", and wrong when the default differs from base).
    "--base",
    baseBranch,
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
