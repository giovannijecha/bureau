import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultRunner, run } from "../src/exec.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { cloneRepo, commitAll, currentBranch, getDiff, getWorkingDiff } from "../src/git.js";

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
