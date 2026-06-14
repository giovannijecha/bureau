import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { defaultCommandRunner } from "../src/run-command.js";

// Drives the REAL runner against `node` (always present in this toolchain) — proves
// argv/exit-code handling, shell:false injection-inertness, and the ENOENT path.

describe("defaultCommandRunner", () => {
  it("runs an argv command, captures stdout, and reports exit 0", async () => {
    const chunks: string[] = [];
    const r = await defaultCommandRunner(["node", "-e", "console.log('hello-test')"], tmpdir(), 30_000, (c) => chunks.push(c));
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("hello-test");
    expect(chunks.join("")).toContain("hello-test"); // streamed live too
  });

  it("reports a non-zero exit code for a failing command", async () => {
    const r = await defaultCommandRunner(["node", "-e", "process.exit(3)"], tmpdir(), 30_000);
    expect(r.code).toBe(3);
  });

  it("does NOT interpret shell metacharacters (shell:false) — chained commands never run", async () => {
    // With a shell, `&& echo INJECTED` would chain a second command. argv-only, the
    // "&&", "echo", "INJECTED" tokens are just inert extra args to node — never run.
    const r = await defaultCommandRunner(["node", "-e", "console.log('start')", "&&", "echo", "INJECTED"], tmpdir(), 30_000);
    expect(r.stdout).toContain("start"); // the real program ran
    expect(r.stdout).not.toContain("INJECTED"); // the injected command did NOT
  });

  it("resolves (never throws) with code -1 when the binary doesn't exist (ENOENT)", async () => {
    const r = await defaultCommandRunner(["definitely-not-a-real-binary-xyz"], tmpdir(), 30_000);
    expect(r.code).toBe(-1);
    expect(r.stdout).toBe("");
  });

  it("times out and kills a wedged process (real spawn), reporting timedOut", async () => {
    const r = await defaultCommandRunner(["node", "-e", "setInterval(() => {}, 1e9)"], tmpdir(), 400);
    expect(r.timedOut).toBe(true); // the timer fired and the child was killed
  }, 15_000);
});
