import { describe, it, expect } from "vitest";
import { runVerify, type CommandResult } from "../src/index.js";

/** A scripted runner: returns the next queued result per call, recording the argv it saw. */
function scriptedRunner(results: CommandResult[]) {
  const calls: { argv: readonly string[]; cwd: string; timeoutMs: number }[] = [];
  let i = 0;
  const run = async (argv: readonly string[], cwd: string, timeoutMs: number): Promise<CommandResult> => {
    calls.push({ argv, cwd, timeoutMs });
    return results[i++] ?? { stdout: "", stderr: "", code: 0, timedOut: false };
  };
  return { run, calls };
}

const ok = (stdout = "ok"): CommandResult => ({ stdout, stderr: "", code: 0, timedOut: false });

describe("runVerify", () => {
  it("passes when every command exits 0", async () => {
    const { run, calls } = scriptedRunner([ok("built"), ok("tested")]);
    const r = await runVerify([["bun", "run", "build"], ["bun", "test"]], "/wt", 1000, run);
    expect(r.passed).toBe(true);
    expect(r.ranCount).toBe(2);
    expect(r.digest).toBe("");
    expect(r.failure).toBeUndefined();
    expect(calls.map((c) => c.argv.join(" "))).toEqual(["bun run build", "bun test"]);
    expect(calls[0]!.cwd).toBe("/wt");
  });

  it("short-circuits at the first failing command and builds an actionable digest", async () => {
    const { run, calls } = scriptedRunner([
      { stdout: "error: key={turn()} is not reactive", stderr: "exit 1", code: 1, timedOut: false },
      ok("tested"), // must NOT run — build failed first
    ]);
    const r = await runVerify([["bun", "run", "build"], ["bun", "test"]], "/wt", 1000, run);
    expect(r.passed).toBe(false);
    expect(r.ranCount).toBe(1); // stopped after the build
    expect(calls).toHaveLength(1); // the test command never ran
    expect(r.failure?.code).toBe(1);
    expect(r.failure?.couldNotRun).toBe(false);
    expect(r.digest).toContain("bun run build");
    expect(r.digest).toContain("exited 1");
    expect(r.digest).toContain("key={turn()}"); // the captured output rides the digest
    expect(r.digest).toMatch(/do NOT weaken/i); // instructs the re-edit to fix, not disable
  });

  it("reports a timeout distinctly", async () => {
    const { run } = scriptedRunner([{ stdout: "", stderr: "", code: -1, timedOut: true }]);
    const r = await runVerify([["bun", "test"]], "/wt", 5000, run);
    expect(r.passed).toBe(false);
    expect(r.failure?.timedOut).toBe(true);
    expect(r.digest).toMatch(/timed out/i);
  });

  it("flags a command that could not even start as couldNotRun (a config problem, not a code bug)", async () => {
    const { run } = scriptedRunner([{ stdout: "", stderr: "spawn ENOENT", code: -1, timedOut: false }]);
    const r = await runVerify([["nope"]], "/wt", 1000, run);
    expect(r.passed).toBe(false);
    expect(r.failure?.couldNotRun).toBe(true);
    expect(r.digest).toContain("could not run");
    expect(r.digest).not.toMatch(/do NOT weaken/i); // re-editing can't fix a missing binary
  });

  it("treats an empty command list as a pass with ranCount 0 (verify simply skipped)", async () => {
    const { run, calls } = scriptedRunner([]);
    const r = await runVerify([], "/wt", 1000, run);
    expect(r.passed).toBe(true);
    expect(r.ranCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("skips empty argv entries without counting them", async () => {
    const { run, calls } = scriptedRunner([ok()]);
    const r = await runVerify([[], ["bun", "test"]], "/wt", 1000, run);
    expect(r.passed).toBe(true);
    expect(r.ranCount).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
