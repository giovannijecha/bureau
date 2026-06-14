import { describe, it, expect } from "vitest";

import { TestCapability } from "../src/index.js";
import type { CommandResult, CommandRunner } from "../src/run-command.js";
import type { CapabilityInput } from "../src/capability.js";
import type { Step, StepId } from "@bureau/core";

const sid = (s: string) => s as unknown as StepId;

function fakeRunner(result: CommandResult) {
  const calls: { argv: readonly string[]; cwd: string; timeoutMs: number }[] = [];
  const run: CommandRunner = async (argv, cwd, timeoutMs, onChunk) => {
    calls.push({ argv, cwd, timeoutMs });
    onChunk?.(result.stdout);
    return result;
  };
  return { run, calls };
}

const step = (): Step => ({ id: sid("s1"), capability: "test", description: "run tests", acceptanceCriteria: [], status: "running", artifactIds: [] });
const input = (over: Partial<CapabilityInput> = {}): CapabilityInput => ({ step: step(), worktreePath: "/wt/task-1", context: "the goal", ...over });

describe("TestCapability", () => {
  it("is kind 'test', not agentic, and runs the configured argv in the worktree", async () => {
    const { run, calls } = fakeRunner({ stdout: "42 passing", stderr: "", code: 0, timedOut: false });
    const cap = new TestCapability({ run });
    expect(cap.kind).toBe("test");

    const out = await cap.execute(input({ testCommand: ["npm", "test"] }));
    expect(calls[0]!.argv).toEqual(["npm", "test"]);
    expect(calls[0]!.cwd).toBe("/wt/task-1");
    expect(out.summary).toMatch(/^✓ Tests passed/);
    expect(out.summary).toContain("42 passing");
  });

  it("OPT-IN: with NO configured command it skips and never spawns anything", async () => {
    const { run, calls } = fakeRunner({ stdout: "", stderr: "", code: 0, timedOut: false });
    const out = await new TestCapability({ run }).execute(input()); // no testCommand
    expect(calls).toHaveLength(0); // ← nothing ran
    expect(out.summary).toContain("No test command configured");
  });

  it("a non-zero exit is an advisory ✗ FAILED (NOT a thrown pipeline error)", async () => {
    const { run } = fakeRunner({ stdout: "1 failing", stderr: "", code: 1, timedOut: false });
    const out = await new TestCapability({ run }).execute(input({ testCommand: ["npm", "test"] }));
    expect(out.summary).toMatch(/^✗ Tests FAILED/);
    expect(out.summary).toContain("exited 1");
  });

  it("a timeout is an advisory ✗ TIMED OUT", async () => {
    const { run } = fakeRunner({ stdout: "", stderr: "", code: -1, timedOut: true });
    const out = await new TestCapability({ run, timeoutMs: 500 }).execute(input({ testCommand: ["sleep", "999"] }));
    expect(out.summary).toMatch(/^✗ Tests TIMED OUT/);
  });

  it("a binary that can't start (code -1) is ADVISORY ⚠ — NEVER throws (a throw would abort the task + discard the edit)", async () => {
    const { run } = fakeRunner({ stdout: "", stderr: "spawn ENOENT", code: -1, timedOut: false });
    const out = await new TestCapability({ run }).execute(input({ testCommand: ["nope"] }));
    expect(out.summary).toMatch(/^⚠ Could not run the tests/);
  });

  it("streams the suite output live via onChunk", async () => {
    const { run } = fakeRunner({ stdout: "live output here", stderr: "", code: 0, timedOut: false });
    const chunks: string[] = [];
    await new TestCapability({ run }).execute(input({ testCommand: ["npm", "test"], onChunk: (c) => chunks.push(c) }));
    expect(chunks.join("")).toContain("live output here");
  });
});
