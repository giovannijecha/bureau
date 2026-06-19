import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultRunner, run } from "../src/exec.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { cloneRepo, commitAll, currentBranch, freshBase, syncToBase, getDiff, getWorkingDiff, getReviewDiff, recentCommits, remoteBranches, headBranch, hasNoCommits, pruneTaskBranches, listTree, treeLastCommits, listAllFiles, fileHistory, showCommit } from "../src/git.js";
import { squashAllAndForcePush } from "../src/git-admin.js";

// These tests drive the REAL git binary against throwaway repos under the OS
// temp dir — deterministic and fully offline (no network, no GitHub).

const gitIn = (cwd: string, args: string[]) => run(defaultRunner, "git", ["-C", cwd, ...args]);

let tmpRoot: string;
let canonical: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "bureau-vcs-"));
  canonical = join(tmpRoot, "canonical");
  mkdirSync(canonical);
  await gitIn(canonical, ["init", "-b", "main"]);
  await gitIn(canonical, ["config", "user.email", "test@bureau.local"]);
  await gitIn(canonical, ["config", "user.name", "Bureau Test"]);
  writeFileSync(join(canonical, "README.md"), "# base\n");
  await gitIn(canonical, ["add", "-A"]);
  await gitIn(canonical, ["commit", "-m", "base"]);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("creates an isolated worktree on a fresh branch", async () => {
    const wtPath = join(tmpRoot, "wt-create");
    const handle = await createWorktree(canonical, "task/abc", wtPath);

    expect(handle).toEqual({ path: wtPath, branch: "task/abc", repoPath: canonical });
    expect(existsSync(join(wtPath, "README.md"))).toBe(true); // checked out the base content
    expect(await currentBranch(wtPath)).toBe("task/abc");
  });
});

describe("hasNoCommits — detect an empty (unborn-HEAD) repo so the browser doesn't error", () => {
  it("is true for a freshly init'd repo with no commits, false once a commit lands", async () => {
    const empty = join(tmpRoot, "empty");
    mkdirSync(empty);
    await gitIn(empty, ["init", "-b", "main"]);
    await gitIn(empty, ["config", "user.email", "test@bureau.local"]);
    await gitIn(empty, ["config", "user.name", "Bureau Test"]);

    expect(await hasNoCommits(empty)).toBe(true);
    // `canonical` (from beforeEach) already has a commit.
    expect(await hasNoCommits(canonical)).toBe(false);

    // Land the first commit → no longer empty.
    writeFileSync(join(empty, "README.md"), "# new\n");
    await gitIn(empty, ["add", "-A"]);
    await gitIn(empty, ["commit", "-m", "first"]);
    expect(await hasNoCommits(empty)).toBe(false);
  });
});

describe("freshBase + createWorktree — branch off the LATEST origin base", () => {
  it("starts a task off origin's advanced main, not the clone's stale local copy", async () => {
    // `canonical` here plays the role of the GitHub origin. Clone it (the engine's
    // canonical clone), THEN advance origin's main — the clone is now stale.
    const clone = join(tmpRoot, "clone-stale");
    await cloneRepo(canonical, clone);
    writeFileSync(join(canonical, "shipped.ts"), "export const shipped = true;\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "shipped by an earlier task"]);

    // Without freshBase the worktree would branch off the stale clone HEAD and
    // miss shipped.ts (→ avoidable conflicts at merge). With it, the base is
    // origin/main and the new file is present.
    const base = await freshBase(clone, "main");
    expect(base).toBe("origin/main");

    const wtPath = join(tmpRoot, "wt-fresh");
    await createWorktree(clone, "task/fresh", wtPath, defaultRunner, base);
    expect(existsSync(join(wtPath, "shipped.ts"))).toBe(true);
  });
});

describe("syncToBase — refresh the clone's working tree to live origin", () => {
  it("updates a stale clone's files to origin's advanced main (what Iris reads in chat)", async () => {
    // `canonical` plays origin. Clone it, then advance origin's main — the clone is
    // now stale (its README still says the old content), exactly the Iris bug.
    const clone = join(tmpRoot, "clone-chat");
    await cloneRepo(canonical, clone);
    expect((await run(defaultRunner, "git", ["-C", clone, "show", "HEAD:README.md"])).trim()).toBe("# base");

    writeFileSync(join(canonical, "README.md"), "# La Guerra Fredda\n");
    writeFileSync(join(canonical, "CONTRIBUTING.md"), "contribute\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "rewrite the README + add CONTRIBUTING"]);

    const synced = await syncToBase(clone, "main");
    expect(synced).toBe(true);

    // The clone's working tree now reflects the LIVE repo: new README content + the
    // new file are present on disk — so a reader (Iris) sees the truth.
    expect(existsSync(join(clone, "README.md"))).toBe(true);
    expect((await run(defaultRunner, "git", ["-C", clone, "show", "HEAD:README.md"])).trim()).toBe("# La Guerra Fredda");
    expect(existsSync(join(clone, "CONTRIBUTING.md"))).toBe(true);
  });

  it("is a no-op (returns false) when origin can't be reached", async () => {
    const lonely = join(tmpRoot, "no-remote");
    mkdirSync(lonely);
    await gitIn(lonely, ["init", "-b", "main"]);
    await gitIn(lonely, ["config", "user.email", "t@b.local"]);
    await gitIn(lonely, ["config", "user.name", "T"]);
    writeFileSync(join(lonely, "x.txt"), "x");
    await gitIn(lonely, ["add", "-A"]);
    await gitIn(lonely, ["commit", "-m", "x"]);
    expect(await syncToBase(lonely, "main")).toBe(false); // no origin → keep what we have
  });
});

describe("getDiff — cumulative across a re-run (the request-changes loop)", () => {
  it("shows the FULL change vs base after a second commit, not just the increment", async () => {
    // Mirrors a request_changes re-run: commit v1, then commit v2 on the same branch.
    // The branch diff vs base must show BOTH files (the whole PR-shaped change), which
    // a working diff (index vs HEAD) would miss after v1 is committed.
    const wtPath = join(tmpRoot, "wt-rerun");
    await createWorktree(canonical, "task/rerun", wtPath);
    writeFileSync(join(wtPath, "v1.ts"), "export const v1 = 1;\n");
    await commitAll(wtPath, "v1");
    writeFileSync(join(wtPath, "v2.ts"), "export const v2 = 2;\n");
    await commitAll(wtPath, "v2 (revision)");

    const diff = await getDiff(wtPath, "main"); // git diff main...HEAD — merge-base relative
    expect(diff).toContain("v1.ts"); // the first commit is still in the diff…
    expect(diff).toContain("v2.ts"); // …alongside the revision — the FULL change
  });

  it("getReviewDiff shows the full change vs base INCLUDING uncommitted work", async () => {
    // The mid-pipeline reviewer's view on a re-run: v1 committed, v2 still in the
    // working tree. getReviewDiff must show BOTH (a working diff would miss v1).
    const wtPath = join(tmpRoot, "wt-reviewdiff");
    await createWorktree(canonical, "task/reviewdiff", wtPath);
    writeFileSync(join(wtPath, "v1.ts"), "export const v1 = 1;\n");
    await commitAll(wtPath, "v1");
    writeFileSync(join(wtPath, "v2.ts"), "export const v2 = 2;\n"); // uncommitted

    const diff = await getReviewDiff(wtPath, "main");
    expect(diff).toContain("v1.ts"); // committed baseline included…
    expect(diff).toContain("v2.ts"); // …plus the uncommitted increment
  });
});

describe("pruneTaskBranches — guarded branch hygiene", () => {
  it("deletes only bureau/task-* branches (not in keep), never main or user branches", async () => {
    // create some local branches off main
    for (const b of ["bureau/task-aaa", "bureau/task-bbb", "feature/keepme"]) {
      await gitIn(canonical, ["branch", b]);
    }
    const deleted = await pruneTaskBranches(canonical, ["bureau/task-bbb"]); // keep bbb

    expect(deleted).toContain("bureau/task-aaa"); // pruned
    expect(deleted).not.toContain("bureau/task-bbb"); // kept (in keep set)
    const left = (await run(defaultRunner, "git", ["-C", canonical, "for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      .split("\n").map((s) => s.trim()).filter(Boolean);
    expect(left).toContain("main"); // never touched
    expect(left).toContain("feature/keepme"); // a non-task branch is never touched
    expect(left).toContain("bureau/task-bbb"); // kept
    expect(left).not.toContain("bureau/task-aaa"); // gone
  });

  it("does not prune a non-existent / already-clean repo (returns [])", async () => {
    expect(await pruneTaskBranches(canonical, [])).not.toContain("main");
  });

  it("reclaims a branch pinned by an ORPHAN worktree (deleted/crashed task left it behind)", async () => {
    // A leftover worktree from a task no longer in the store. git refuses `branch -D`
    // on a branch checked out in a worktree — so without releasing the worktree first,
    // this branch could never be pruned and "Clean up branches" would leave it forever.
    const wtPath = join(tmpRoot, "wt-orphan");
    await createWorktree(canonical, "bureau/task-orphan", wtPath);
    expect(existsSync(wtPath)).toBe(true);

    const deleted = await pruneTaskBranches(canonical, []); // nothing kept → orphan is prunable

    expect(deleted).toContain("bureau/task-orphan"); // branch reclaimed…
    expect(existsSync(wtPath)).toBe(false); // …and its worktree removed from disk
    const left = (await run(defaultRunner, "git", ["-C", canonical, "for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      .split("\n").map((s) => s.trim()).filter(Boolean);
    expect(left).not.toContain("bureau/task-orphan");
    expect(left).toContain("main"); // the canonical/main worktree is never touched
  });

  it("never removes an IN-FLIGHT task's worktree (its branch is in keep)", async () => {
    // An active task's worktree must survive cleanup — its branch is in `keep`.
    const wtPath = join(tmpRoot, "wt-inflight");
    await createWorktree(canonical, "bureau/task-inflight", wtPath);

    const deleted = await pruneTaskBranches(canonical, ["bureau/task-inflight"]);

    expect(deleted).not.toContain("bureau/task-inflight");
    expect(existsSync(wtPath)).toBe(true); // worktree intact
    expect(await currentBranch(wtPath)).toBe("bureau/task-inflight");
  });
});

describe("read-only repo inspection (Git console)", () => {
  it("reads recent commits, the head branch, and origin branches", async () => {
    const clone = join(tmpRoot, "clone-console");
    await cloneRepo(canonical, clone);
    // a second commit on origin, then refresh the clone
    writeFileSync(join(canonical, "feature.ts"), "export const x = 1;\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "add a feature"]);
    await syncToBase(clone, "main");

    const commits = await recentCommits(clone, 10);
    expect(commits.length).toBe(2);
    expect(commits[0]!.subject).toBe("add a feature"); // newest first
    expect(commits[0]!.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(commits[1]!.subject).toBe("base");

    expect(await headBranch(clone)).toBe("main");
    expect(await remoteBranches(clone)).toContain("main"); // origin/HEAD excluded
  });

  it("returns empty (never throws) on a repo with no commits", async () => {
    const empty = join(tmpRoot, "empty-repo");
    mkdirSync(empty);
    await gitIn(empty, ["init", "-b", "main"]);
    expect(await recentCommits(empty, 5)).toEqual([]);
    expect(await remoteBranches(empty)).toEqual([]);
  });
});

describe("read-only codebase browser + commit viewer (embedded GitHub)", () => {
  it("treeLastCommits — the latest commit that touched each entry (per-file column)", async () => {
    mkdirSync(join(canonical, "src"));
    writeFileSync(join(canonical, "src", "app.ts"), "export const app = 1;\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "add app"]);
    writeFileSync(join(canonical, "README.md"), "# base v2\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "update readme"]);

    const byPath = new Map((await treeLastCommits(canonical, "main", "")).map((c) => [c.path, c]));
    expect(byPath.get("README.md")!.subject).toBe("update readme"); // README's latest touch
    expect(byPath.get("src")!.subject).toBe("add app"); // the dir's latest touch
    expect(byPath.get("README.md")!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/); // strict ISO
  });

  it("listAllFiles — every file path, recursively, at ref (the 'go to file' finder)", async () => {
    mkdirSync(join(canonical, "src"));
    writeFileSync(join(canonical, "src", "app.ts"), "x");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "add src"]);

    const { paths, truncated } = await listAllFiles(canonical, "main");
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/app.ts");
    expect(truncated).toBe(false);
  });

  it("fileHistory — commits that touched a file, newest first", async () => {
    writeFileSync(join(canonical, "README.md"), "# base v2\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "touch readme again"]);

    const hist = await fileHistory(canonical, "main", "README.md", 50);
    expect(hist[0]!.subject).toBe("touch readme again"); // newest first
    expect(hist.some((c) => c.subject === "base")).toBe(true); // the original commit too
  });

  it("showCommit — metadata, per-file stats, and patch", async () => {
    writeFileSync(join(canonical, "feature.ts"), "export const f = 1;\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "add feature"]);
    const head = (await run(defaultRunner, "git", ["-C", canonical, "rev-parse", "HEAD"])).trim();

    const detail = await showCommit(canonical, head);
    expect(detail).not.toBeNull();
    expect(detail!.subject).toBe("add feature");
    expect(detail!.files.some((f) => f.path === "feature.ts" && f.additions === 1 && !f.binary)).toBe(true);
    expect(detail!.patch).toContain("+export const f = 1;");
    expect(detail!.truncated).toBe(false);
  });

  it("showCommit — a rename surfaces the NEW path, never an 'old => new' arrow string", async () => {
    writeFileSync(join(canonical, "old-name.ts"), "export const x = 1;\n");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "add old-name"]);
    await gitIn(canonical, ["mv", "old-name.ts", "new-name.ts"]);
    await gitIn(canonical, ["commit", "-m", "rename it"]);
    const head = (await run(defaultRunner, "git", ["-C", canonical, "rev-parse", "HEAD"])).trim();

    const detail = await showCommit(canonical, head);
    const paths = detail!.files.map((f) => f.path);
    expect(paths).toContain("new-name.ts"); // the post-image path…
    expect(paths.join(" ")).not.toContain("=>"); // …never the literal numstat arrow
  });

  it("listTree / listAllFiles return non-ASCII paths VERBATIM (-z, not C-quoted)", async () => {
    // Default core.quotePath would emit `"\316\251-file.ts"`; `-z` keeps it literal.
    const name = "Ω-file.ts"; // Ω — a single codepoint, no NFC/NFD ambiguity
    writeFileSync(join(canonical, name), "x");
    await gitIn(canonical, ["add", "-A"]);
    await gitIn(canonical, ["commit", "-m", "add a unicode-named file"]);

    expect((await listTree(canonical, "main", "")).map((e) => e.name)).toContain(name);
    expect((await listAllFiles(canonical, "main")).paths).toContain(name);
  });

  it("is graceful + injection-safe: null on an unknown commit, throws on a flag-like ref", async () => {
    expect(await showCommit(canonical, "0000000")).toBeNull(); // well-formed but unknown → null, no throw
    await expect(treeLastCommits(canonical, "-rf", "")).rejects.toThrow(); // a "-"-leading ref can't be a flag
    await expect(listAllFiles(canonical, "--output=x")).rejects.toThrow();
  });
});

describe("getWorkingDiff", () => {
  it("includes new (untracked) files as additions", async () => {
    const wtPath = join(tmpRoot, "wt-working");
    await createWorktree(canonical, "task/edit", wtPath);
    writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");

    const diff = await getWorkingDiff(wtPath);
    expect(diff).toContain("feature.ts");
    expect(diff).toContain("+export const x = 1;");
  });
});

describe("commitAll + getDiff", () => {
  it("commits the worktree changes and diffs them against the base branch", async () => {
    const wtPath = join(tmpRoot, "wt-commit");
    await createWorktree(canonical, "task/feat", wtPath);
    writeFileSync(join(wtPath, "feature.ts"), "export const x = 1;\n");

    await commitAll(wtPath, "add feature");

    const diff = await getDiff(wtPath, "main");
    expect(diff).toContain("feature.ts");
    expect(diff).toContain("+export const x = 1;");
    // After committing, the working tree is clean.
    expect((await getWorkingDiff(wtPath)).trim()).toBe("");
  });
});

describe("removeWorktree", () => {
  it("removes the worktree directory and its admin entry", async () => {
    const wtPath = join(tmpRoot, "wt-remove");
    const handle = await createWorktree(canonical, "task/tmp", wtPath);
    expect(existsSync(wtPath)).toBe(true);

    await removeWorktree(handle);

    expect(existsSync(wtPath)).toBe(false);
    expect(await gitIn(canonical, ["worktree", "list"])).not.toContain("wt-remove");
  });
});

describe("cloneRepo", () => {
  it("clones from a local source path", async () => {
    const dest = join(tmpRoot, "clone");
    await cloneRepo(canonical, dest);

    expect(existsSync(join(dest, "README.md"))).toBe(true);
    expect(await currentBranch(dest)).toBe("main");
  });

  it("refuses to clone into an existing non-empty directory", async () => {
    const dest = join(tmpRoot, "occupied");
    mkdirSync(dest);
    writeFileSync(join(dest, "stray.txt"), "x");
    await expect(cloneRepo(canonical, dest)).rejects.toThrow(/already exists and is not empty/);
  });
});

describe("commitAll — empty changeset", () => {
  it("returns false without throwing when there is nothing to commit", async () => {
    const wtPath = join(tmpRoot, "wt-noop");
    await createWorktree(canonical, "task/noop", wtPath);
    expect(await commitAll(wtPath, "no changes")).toBe(false);
  });
});

describe("getDiff — missing base", () => {
  it("throws a clear error naming the base when it does not resolve", async () => {
    const wtPath = join(tmpRoot, "wt-badbase");
    await createWorktree(canonical, "task/badbase", wtPath);
    await expect(getDiff(wtPath, "nonexistent-branch")).rejects.toThrow(
      /Diff base ref "nonexistent-branch" was not found/
    );
  });
});

describe("removeWorktree — dirty worktree", () => {
  it("refuses without force, succeeds with force", async () => {
    const wtPath = join(tmpRoot, "wt-dirty");
    const handle = await createWorktree(canonical, "task/dirty", wtPath);
    writeFileSync(join(wtPath, "scratch.txt"), "uncommitted"); // makes the worktree dirty

    await expect(removeWorktree(handle)).rejects.toThrow();
    expect(existsSync(wtPath)).toBe(true);

    await removeWorktree(handle, { force: true });
    expect(existsSync(wtPath)).toBe(false);
  });
});

describe("squashAllAndForcePush — empty repo (the 'delete all files' case)", () => {
  const id = { name: "Bureau", email: "bureau@localhost" };

  it("squashes a repo with NO tracked files into a single empty commit and pushes it", async () => {
    // Reproduces the CEO's screenshot: a repo emptied by a "delete all files" task, then
    // "Squash all → one commit + push" — which used to die on "nothing to commit".
    const origin = join(tmpRoot, "origin.git");
    await gitIn(tmpRoot, ["init", "--bare", "-b", "main", "origin.git"]);
    const clone = join(tmpRoot, "clone-squash-empty");
    await cloneRepo(origin, clone);
    await gitIn(clone, ["config", "user.email", "t@b.local"]);
    await gitIn(clone, ["config", "user.name", "T"]);
    // Seed a couple of commits, push, THEN delete every tracked file (empty the repo).
    writeFileSync(join(clone, "a.txt"), "a\n");
    writeFileSync(join(clone, "b.txt"), "b\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "seed"]);
    await gitIn(clone, ["push", "-u", "origin", "main"]);
    await gitIn(clone, ["rm", "-r", "."]);
    await gitIn(clone, ["commit", "-m", "empty the repo"]);
    await gitIn(clone, ["push", "origin", "main"]); // origin/main now matches → lease will pass

    await squashAllAndForcePush(clone, "main", "Reset to a single empty commit", id, defaultRunner);

    // Exactly one commit, holding an EMPTY tree (no tracked files) — proof --allow-empty worked.
    const count = (await gitIn(clone, ["rev-list", "--count", "main"])).trim();
    expect(count).toBe("1");
    const tracked = (await gitIn(clone, ["ls-files"])).trim();
    expect(tracked).toBe("");
    const subject = (await gitIn(clone, ["log", "-1", "--format=%s", "main"])).trim();
    expect(subject).toBe("Reset to a single empty commit");
    // …and it was force-pushed: the bare origin's main is the same single commit.
    const originCount = (await gitIn(origin, ["rev-list", "--count", "main"])).trim();
    expect(originCount).toBe("1");
  });

  it("still squashes a NON-empty repo into one commit that keeps the current tree", async () => {
    // The change must not regress the normal case (files present).
    const origin = join(tmpRoot, "origin2.git");
    await gitIn(tmpRoot, ["init", "--bare", "-b", "main", "origin2.git"]);
    const clone = join(tmpRoot, "clone-squash-full");
    await cloneRepo(origin, clone);
    await gitIn(clone, ["config", "user.email", "t@b.local"]);
    await gitIn(clone, ["config", "user.name", "T"]);
    writeFileSync(join(clone, "keep.txt"), "keep me\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "v1"]);
    writeFileSync(join(clone, "also.txt"), "also\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "v2"]);
    await gitIn(clone, ["push", "-u", "origin", "main"]);

    await squashAllAndForcePush(clone, "main", "Squashed history", id, defaultRunner);

    const count = (await gitIn(clone, ["rev-list", "--count", "main"])).trim();
    expect(count).toBe("1"); // history collapsed…
    const tracked = (await gitIn(clone, ["ls-files"])).trim().split("\n").sort();
    expect(tracked).toEqual(["also.txt", "keep.txt"]); // …but the current tree is preserved
  });

  it("squashes the TARGET branch's OWN tree, never the clone's checked-out (base) tree", async () => {
    // The data-loss case: the canonical clone is parked on `main` (as syncToBase leaves it),
    // but the CEO squashes a different branch. A checkout-based squash would publish main's
    // tree onto `feature` and silently destroy feature's content. The plumbing squash must
    // collapse FEATURE's own tree instead.
    const origin = join(tmpRoot, "origin3.git");
    await gitIn(tmpRoot, ["init", "--bare", "-b", "main", "origin3.git"]);
    const clone = join(tmpRoot, "clone-squash-cross");
    await cloneRepo(origin, clone);
    await gitIn(clone, ["config", "user.email", "t@b.local"]);
    await gitIn(clone, ["config", "user.name", "T"]);
    writeFileSync(join(clone, "main.txt"), "main\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "main v1"]);
    await gitIn(clone, ["push", "-u", "origin", "main"]);
    await gitIn(clone, ["checkout", "-b", "feature"]);
    writeFileSync(join(clone, "feat.txt"), "feat\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "feat a"]);
    writeFileSync(join(clone, "feat2.txt"), "feat2\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "feat b"]);
    await gitIn(clone, ["push", "-u", "origin", "feature"]);
    await gitIn(clone, ["checkout", "main"]); // park HEAD on the base — the danger condition

    await squashAllAndForcePush(clone, "feature", "Squash feature", id, defaultRunner);

    const count = (await gitIn(clone, ["rev-list", "--count", "feature"])).trim();
    expect(count).toBe("1"); // feature collapsed to one commit…
    const tracked = (await gitIn(clone, ["ls-tree", "-r", "--name-only", "feature"])).trim().split("\n").sort();
    expect(tracked).toEqual(["feat.txt", "feat2.txt", "main.txt"]); // …holding FEATURE's tree, not main's
    expect(await currentBranch(clone)).toBe("main"); // the clone's HEAD/worktree is left alone
    const originCount = (await gitIn(origin, ["rev-list", "--count", "feature"])).trim();
    expect(originCount).toBe("1"); // and it was force-pushed
  });

  it("is idempotent — a second squash succeeds (no stranded temp branch wedges it)", async () => {
    const origin = join(tmpRoot, "origin4.git");
    await gitIn(tmpRoot, ["init", "--bare", "-b", "main", "origin4.git"]);
    const clone = join(tmpRoot, "clone-squash-twice");
    await cloneRepo(origin, clone);
    await gitIn(clone, ["config", "user.email", "t@b.local"]);
    await gitIn(clone, ["config", "user.name", "T"]);
    writeFileSync(join(clone, "x.txt"), "x\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "v1"]);
    writeFileSync(join(clone, "y.txt"), "y\n");
    await gitIn(clone, ["add", "-A"]);
    await gitIn(clone, ["commit", "-m", "v2"]);
    await gitIn(clone, ["push", "-u", "origin", "main"]);

    await squashAllAndForcePush(clone, "main", "first", id, defaultRunner);
    await squashAllAndForcePush(clone, "main", "second", id, defaultRunner); // must not throw

    const count = (await gitIn(clone, ["rev-list", "--count", "main"])).trim();
    expect(count).toBe("1");
    const subject = (await gitIn(clone, ["log", "-1", "--format=%s", "main"])).trim();
    expect(subject).toBe("second");
  });
});
