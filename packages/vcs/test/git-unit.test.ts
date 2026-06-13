import { describe, it, expect } from "vitest";

import { run, assertSafeRef, VcsError, type Runner, type ExecResult } from "../src/exec.js";
import { push, openPr, commitAll, getDiff, cloneRepo } from "../src/git.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });

// A runner that records calls and resolves each via the supplied function.
function makeRunner(resolve: (cmd: string, args: string[]) => ExecResult = () => ok()) {
  const calls: { cmd: string; args: string[]; opts?: { cwd?: string } }[] = [];
  const r: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return resolve(cmd, args);
  };
  return { run: r, calls };
}

describe("run() / VcsError", () => {
  it("returns stdout on a zero exit", async () => {
    expect(await run(makeRunner(() => ok("hello")).run, "git", ["x"])).toBe("hello");
  });

  it("throws a VcsError carrying the command and stderr on a non-zero exit", async () => {
    const r = makeRunner(() => ({ stdout: "", stderr: "fatal: nope", code: 128 })).run;
    await expect(run(r, "git", ["status"])).rejects.toBeInstanceOf(VcsError);
    await expect(run(r, "git", ["status"])).rejects.toThrow(/git status.*exit 128.*fatal: nope/);
  });

  it("passes cwd through to the runner when provided", async () => {
    const { run: r, calls } = makeRunner();
    await run(r, "git", ["status"], "/repo");
    expect(calls[0]!.opts).toEqual({ cwd: "/repo" });
  });
});

describe("assertSafeRef", () => {
  it("accepts plain refs", () => {
    expect(() => assertSafeRef("main", "x")).not.toThrow();
    expect(() => assertSafeRef("bureau/task-1", "x")).not.toThrow();
  });

  it.each(["--force", "-x", "a b", "a..b", "", "feat~1", "a:b"])(
    "rejects the unsafe ref %j",
    (bad) => {
      expect(() => assertSafeRef(bad, "branch")).toThrow(VcsError);
    }
  );
});

describe("push", () => {
  it("runs `git -C <wt> push -u origin <branch>`", async () => {
    const { run: r, calls } = makeRunner();
    await push("/wt", "task/x", r);
    expect(calls[0]).toEqual({ cmd: "git", args: ["-C", "/wt", "push", "-u", "origin", "task/x"], opts: {} });
  });

  it("refuses an unsafe branch before spawning git", async () => {
    await expect(push("/wt", "--force", makeRunner().run)).rejects.toThrow(/Unsafe push branch/);
  });
});

describe("openPr", () => {
  it("runs `gh pr create ...` and returns the trimmed PR URL", async () => {
    const { run: r, calls } = makeRunner(() => ok("https://github.com/o/r/pull/7\n"));
    const url = await openPr("o/r", "task/x", "My title", "My body", r);

    expect(url).toBe("https://github.com/o/r/pull/7");
    expect(calls[0]!.cmd).toBe("gh");
    expect(calls[0]!.args).toEqual([
      "pr", "create",
      "--repo", "o/r",
      "--head", "task/x",
      "--title", "My title",
      "--body", "My body",
    ]);
  });
});

describe("commitAll", () => {
  it("stages, detects changes, and commits — returning true", async () => {
    const { run: r, calls } = makeRunner((_c, args) =>
      args.includes("--quiet") ? { stdout: "", stderr: "", code: 1 } : ok()
    );
    expect(await commitAll("/wt", "msg", r)).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      ["-C", "/wt", "add", "-A"],
      ["-C", "/wt", "diff", "--cached", "--quiet"],
      ["-C", "/wt", "commit", "-m", "msg"],
    ]);
  });

  it("returns false without committing when nothing is staged (no-op edit)", async () => {
    const { run: r, calls } = makeRunner(); // --quiet → code 0 → clean
    expect(await commitAll("/wt", "msg", r)).toBe(false);
    expect(calls.map((c) => c.args)).toEqual([
      ["-C", "/wt", "add", "-A"],
      ["-C", "/wt", "diff", "--cached", "--quiet"],
    ]);
  });
});

describe("getDiff", () => {
  it("validates the base, verifies it resolves, then diffs base...HEAD", async () => {
    const { run: r, calls } = makeRunner(() => ok("diff-output"));
    expect(await getDiff("/wt", "main", r)).toBe("diff-output");
    expect(calls.map((c) => c.args)).toEqual([
      ["-C", "/wt", "rev-parse", "--verify", "--quiet", "main"],
      ["-C", "/wt", "diff", "main...HEAD"],
    ]);
  });

  it("rejects an unsafe base", async () => {
    await expect(getDiff("/wt", "--output=x", makeRunner().run)).rejects.toThrow(/Unsafe diff base/);
  });

  it("throws a clear error when the base does not resolve", async () => {
    const r = makeRunner((_c, args) =>
      args.includes("--verify") ? { stdout: "", stderr: "", code: 1 } : ok()
    ).run;
    await expect(getDiff("/wt", "nope", r)).rejects.toThrow(/Diff base ref "nope" was not found/);
  });
});

describe("cloneRepo", () => {
  it("clones with a -- separator before source and dest", async () => {
    const { run: r, calls } = makeRunner();
    await cloneRepo("https://x/y.git", "/definitely/missing/dest", r);
    expect(calls[0]!.args).toEqual(["clone", "--", "https://x/y.git", "/definitely/missing/dest"]);
  });
});

describe("createWorktree (args)", () => {
  it("validates the branch and inserts -- before the worktree path", async () => {
    const { run: r, calls } = makeRunner();
    await createWorktree("/repo", "bureau/task-1", "/wt", r);
    expect(calls[0]!.args).toEqual(["-C", "/repo", "worktree", "add", "-b", "bureau/task-1", "--", "/wt"]);
  });

  it("rejects an unsafe branch", async () => {
    await expect(createWorktree("/repo", "--force", "/wt", makeRunner().run)).rejects.toThrow(/Unsafe branch/);
  });
});

describe("removeWorktree", () => {
  it("runs from the canonical clone with a -- before the path", async () => {
    const { run: r, calls } = makeRunner();
    await removeWorktree({ path: "/wt", branch: "b", repoPath: "/repo" }, undefined, r);
    expect(calls[0]!.args).toEqual(["-C", "/repo", "worktree", "remove", "--", "/wt"]);
  });

  it("adds --force when requested", async () => {
    const { run: r, calls } = makeRunner();
    await removeWorktree({ path: "/wt", branch: "b", repoPath: "/repo" }, { force: true }, r);
    expect(calls[0]!.args).toEqual(["-C", "/repo", "worktree", "remove", "--force", "--", "/wt"]);
  });
});
