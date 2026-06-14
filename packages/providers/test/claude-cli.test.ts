import { describe, it, expect } from "vitest";

import {
  ClaudeCliProvider,
  renderCliPrompt,
  parseCliJson,
  type CliRunner,
  type CliResult,
} from "../src/claude-cli.js";
import { DEFAULT_MODEL } from "../src/anthropic.js";
import type { Message } from "../src/provider.js";

const stubStrategy = { kind: "cli-delegation" as const, isAvailable: () => true };

function fakeRunner(result: CliResult): {
  run: CliRunner;
  calls: { cli: string; args: string[]; input: string; cwd?: string }[];
} {
  const calls: { cli: string; args: string[]; input: string; cwd?: string }[] = [];
  const run: CliRunner = async (cli, args, input, cwd) => {
    calls.push({ cli, args, input, cwd });
    return result;
  };
  return { run, calls };
}

const okJson = (result: string, input = 8, output = 4) =>
  JSON.stringify({ result, usage: { input_tokens: input, output_tokens: output } });

describe("ClaudeCliProvider — send", () => {
  it("invokes the CLI with model + system-prompt and parses result + usage", async () => {
    const { run, calls } = fakeRunner({ stdout: okJson("delegated answer", 8, 4), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    const messages: Message[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "question?" },
    ];
    const res = await provider.send(messages);

    expect(res).toEqual({ content: "delegated answer", inputTokens: 8, outputTokens: 4 });
    const call = calls[0]!;
    expect(call.cli).toBe("claude");
    expect(call.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      DEFAULT_MODEL,
      "--system-prompt",
      "be brief",
      "--tools",
      "Read",
      "Glob",
      "Grep",
    ]);
    expect(call.input).toBe("question?"); // single user turn → raw prompt on stdin
  });

  it("runs in the given cwd and restricts the agent to read-only tools (no Edit/Write/Bash)", async () => {
    const { run, calls } = fakeRunner({ stdout: okJson("x"), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    await provider.send([{ role: "user", content: "edit a file" }], { cwd: "/wt/task-1" });

    const call = calls[0]!;
    expect(call.cwd).toBe("/wt/task-1"); // confined to the worktree
    const ti = call.args.indexOf("--tools");
    expect(ti).toBeGreaterThan(-1);
    expect(call.args.slice(ti + 1)).toEqual(["Read", "Glob", "Grep"]); // exclusive allowlist
    for (const writeTool of ["Edit", "Write", "MultiEdit", "Bash", "NotebookEdit"]) {
      expect(call.args).not.toContain(writeTool);
    }
  });

  it("omits --system-prompt when there is no system message", async () => {
    const { run, calls } = fakeRunner({ stdout: okJson("ok"), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    await provider.send([{ role: "user", content: "hi" }]);
    expect(calls[0]!.args).not.toContain("--system-prompt");
  });

  it("throws with stderr when the CLI exits non-zero", async () => {
    const { run } = fakeRunner({ stdout: "", stderr: "boom", code: 2 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    await expect(provider.send([{ role: "user", content: "hi" }])).rejects.toThrow(/exited with code 2: boom/);
  });

  it("respects a custom cli binary and model", async () => {
    const { run, calls } = fakeRunner({ stdout: okJson("x"), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({
      authStrategy: stubStrategy,
      run,
      cli: "/opt/claude",
      model: "claude-haiku-4-5",
    });

    expect(provider.name).toBe("claude-cli:claude-haiku-4-5");
    await provider.send([{ role: "user", content: "hi" }]);
    expect(calls[0]!.cli).toBe("/opt/claude");
    expect(calls[0]!.args).toContain("claude-haiku-4-5");
  });
});

describe("ClaudeCliProvider — stream", () => {
  it("falls back to a single chunk containing the full answer", async () => {
    const { run } = fakeRunner({ stdout: okJson("whole answer", 5, 6), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    const chunks: string[] = [];
    const res = await provider.stream([{ role: "user", content: "hi" }], (c) => chunks.push(c));

    expect(chunks).toEqual(["whole answer"]);
    expect(res).toEqual({ content: "whole answer", inputTokens: 5, outputTokens: 6 });
  });
});

describe("renderCliPrompt", () => {
  it("returns the raw content for a single user turn", () => {
    expect(renderCliPrompt([{ role: "user", content: "just this" }])).toEqual({
      system: undefined,
      prompt: "just this",
    });
  });

  it("labels roles for multi-turn conversations and splits system out", () => {
    const { system, prompt } = renderCliPrompt([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
    expect(system).toBe("sys");
    expect(prompt).toBe("Human: u1\n\nAssistant: a1\n\nHuman: u2");
  });
});

describe("parseCliJson", () => {
  it("parses result and usage", () => {
    expect(parseCliJson(okJson("hi", 1, 2))).toEqual({ content: "hi", inputTokens: 1, outputTokens: 2 });
  });

  it("defaults usage to zero when absent and result to empty when missing", () => {
    expect(parseCliJson(JSON.stringify({ result: "only" }))).toEqual({
      content: "only",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(parseCliJson(JSON.stringify({ foo: "bar" }))).toEqual({
      content: "",
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("throws on non-JSON output", () => {
    expect(() => parseCliJson("not json at all")).toThrow(/non-JSON output/);
  });

  it("throws when the envelope reports is_error, even with a result string present", () => {
    expect(() =>
      parseCliJson(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: overloaded" }))
    ).toThrow(/reported an error \(error_during_execution\)/);
  });
});

describe("ClaudeCliProvider — CLI-reported errors & input validation", () => {
  it("send() throws when the CLI exits 0 but sets is_error (max turns)", async () => {
    const { run } = fakeRunner({
      stdout: JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "partial", usage: { input_tokens: 9, output_tokens: 1 } }),
      stderr: "",
      code: 0,
    });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });
    await expect(provider.send([{ role: "user", content: "hi" }])).rejects.toThrow(/error_max_turns/);
  });

  it("send() rejects an empty or system-only message list before spawning the CLI", async () => {
    const { run, calls } = fakeRunner({ stdout: okJson("x"), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    await expect(provider.send([])).rejects.toThrow(/at least one user\/assistant message/);
    await expect(provider.send([{ role: "system", content: "only" }])).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0); // never ran the CLI
  });

  it("stream() does not emit a chunk when the answer is empty", async () => {
    const { run } = fakeRunner({ stdout: JSON.stringify({ result: "", usage: {} }), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    const chunks: string[] = [];
    await provider.stream([{ role: "user", content: "hi" }], (c) => chunks.push(c));
    expect(chunks).toEqual([]);
  });
});
