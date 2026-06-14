import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultRunner, run } from "../src/exec.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { cloneRepo, commitAll, currentBranch, freshBase, syncToBase, getDiff, getWorkingDiff } from "../src/git.js";

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
