import { describe, it, expect } from "vitest";

import {
  ClaudeCliProvider,
  defaultCliRunner,
  renderCliPrompt,
  parseCliJson,
  parseStreamJson,
  emitStreamChunk,
  CLI_TIMEOUT_SENTINEL,
  DEFAULT_CLI_TIMEOUT_MS,
  DEFAULT_EDIT_TIMEOUT_MS,
  type CliRunner,
  type CliResult,
} from "../src/claude-cli.js";
import { DEFAULT_MODEL } from "../src/anthropic.js";
import type { Message } from "../src/provider.js";

/** A runner that returns a queued result per call (last one repeats), counting calls. */
function seqRunner(results: CliResult[]): { run: CliRunner; count: () => number } {
  let i = 0;
  const run: CliRunner = async (_cli, _args, _input, _cwd, _t, onStdout) => {
    const r = results[Math.min(i, results.length - 1)]!;
    i++;
    onStdout?.(r.stdout);
    return r;
  };
  return { run, count: () => i };
}

const stubStrategy = { kind: "cli-delegation" as const, isAvailable: () => true };

function fakeRunner(result: CliResult): {
  run: CliRunner;
  calls: { cli: string; args: string[]; input: string; cwd?: string; timeoutMs?: number }[];
} {
  const calls: { cli: string; args: string[]; input: string; cwd?: string; timeoutMs?: number }[] = [];
  const run: CliRunner = async (cli, args, input, cwd, timeoutMs, onStdout) => {
    calls.push({ cli, args, input, cwd, timeoutMs });
    onStdout?.(result.stdout); // simulate the CLI emitting its stdout (one chunk)
    return result;
  };
  return { run, calls };
}

const okJson = (result: string, input = 8, output = 4) =>
  JSON.stringify({ result, usage: { input_tokens: input, output_tokens: output } });

/** A realistic stream-json transcript: system init, assistant turns, final result. */
function streamJson(blocks: { text?: string; tool?: { name: string; input: unknown } }[], result: string, input = 12, output = 8) {
  const lines = [JSON.stringify({ type: "system", subtype: "init" })];
  for (const b of blocks) {
    const content = b.text !== undefined ? [{ type: "text", text: b.text }] : [{ type: "tool_use", name: b.tool!.name, input: b.tool!.input }];
    lines.push(JSON.stringify({ type: "assistant", message: { model: DEFAULT_MODEL, content } }));
  }
  lines.push(JSON.stringify({ type: "result", subtype: "success", result, usage: { input_tokens: input, output_tokens: output } }));
  return lines.join("\n") + "\n";
}

describe("ClaudeCliProvider — send", () => {
  it("invokes the CLI with model + system-prompt and parses result + usage", async () => {
    const { run, calls } = fakeRunner({ stdout: okJson("delegated answer", 8, 4), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    const messages: Message[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "question?" },
    ];
    const res = await provider.send(messages);

    expect(res).toEqual({ content: "delegated answer", inputTokens: 8, outputTokens: 4, model: DEFAULT_MODEL });
    const call = calls[0]!;
    expect(call.cli).toBe("claude");
    expect(call.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      DEFAULT_MODEL,
      "--append-system-prompt",
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
  it("uses stream-json (--verbose), streams text + tool-use lines, and parses the final result", async () => {
    const stdout = streamJson(
      [{ text: "Looking at the file." }, { tool: { name: "Edit", input: { file_path: "README.md" } } }, { text: "Done — added a section." }],
      "Done — added a section.",
      12,
      8
    );
    const { run, calls } = fakeRunner({ stdout, stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    const chunks: string[] = [];
    const res = await provider.stream([{ role: "user", content: "edit" }], (c) => chunks.push(c), {
      acceptEdits: true,
      cwd: "/wt",
      tools: ["Read", "Edit"],
    });

    const joined = chunks.join("");
    expect(joined).toContain("Looking at the file.");
    expect(joined).toContain("→ Edit README.md"); // tool call surfaced compactly
    expect(joined).toContain("Done — added a section.");
    expect(res).toEqual({ content: "Done — added a section.", inputTokens: 12, outputTokens: 8, model: DEFAULT_MODEL });

    const args = calls[0]!.args;
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose"); // required with stream-json in -p mode
    expect(args).toContain("--add-dir"); // acceptEdits path keeps the worktree confinement
  });

  it("gives the EDIT worker the longer timeout, read-only the shorter one", async () => {
    // The edit (acceptEdits, never retried) needs a bigger budget than a read-only call.
    const { run, calls } = fakeRunner({ stdout: okJson("ok"), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });

    await provider.send([{ role: "user", content: "read" }]); // read-only
    expect(calls[0]!.timeoutMs).toBe(DEFAULT_CLI_TIMEOUT_MS);

    await provider.send([{ role: "user", content: "edit" }], { acceptEdits: true, cwd: "/wt" });
    expect(calls[1]!.timeoutMs).toBe(DEFAULT_EDIT_TIMEOUT_MS);
    expect(DEFAULT_EDIT_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CLI_TIMEOUT_MS);
  });

  it("honors a configured editTimeoutMs (e.g. from BUREAU_EDIT_TIMEOUT)", async () => {
    const { run, calls } = fakeRunner({ stdout: okJson("ok"), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run, editTimeoutMs: 900_000 });
    await provider.send([{ role: "user", content: "edit" }], { acceptEdits: true, cwd: "/wt" });
    expect(calls[0]!.timeoutMs).toBe(900_000);
  });

  it("requires at least one non-system message", async () => {
    const { run } = fakeRunner({ stdout: "", stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });
    await expect(provider.stream([{ role: "system", content: "x" }], () => {})).rejects.toThrow(/at least one/);
  });
});

describe("emitStreamChunk — structured tool activity", () => {
  it("calls onToolUse with a compact summary per tool, alongside the text stream", () => {
    const chunks: string[] = [];
    const tools: string[] = [];
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "thinking" }, { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] },
    });
    emitStreamChunk(line, (c) => chunks.push(c), (s) => tools.push(s));
    expect(tools).toEqual(["Read src/a.ts"]); // structured summary — no "→ " prefix
    expect(chunks.join("")).toContain("→ Read src/a.ts"); // text stream unchanged (workers rely on it)
    expect(chunks.join("")).toContain("thinking");
  });

  it("works without onToolUse (workers pass only onChunk)", () => {
    const chunks: string[] = [];
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] } });
    expect(() => emitStreamChunk(line, (c) => chunks.push(c))).not.toThrow();
    expect(chunks.join("")).toContain("→ Bash: git status");
  });
});

describe("ClaudeCliProvider — retry & reliability", () => {
  const timeout = (): CliResult => ({ stdout: "", stderr: `${CLI_TIMEOUT_SENTINEL}claude CLI timed out after 240000ms`, code: -1 });

  it("retries a read-only call after a TIMEOUT, then succeeds", async () => {
    const { run, count } = seqRunner([timeout(), { stdout: okJson("recovered"), stderr: "", code: 0 }]);
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });
    const res = await provider.send([{ role: "user", content: "read something" }]); // read-only (no acceptEdits)
    expect(res.content).toBe("recovered");
    expect(count()).toBe(2); // one retry
  });

  it("does NOT retry a non-timeout CLI error — single call", async () => {
    const { run, count } = seqRunner([{ stdout: "", stderr: "boom", code: 2 }]);
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });
    await expect(provider.send([{ role: "user", content: "x" }])).rejects.toThrow(/exited with code 2/);
    expect(count()).toBe(1);
  });

  it("NEVER retries the edit worker (acceptEdits), even on a timeout — no double-apply of a partial edit", async () => {
    const { run, count } = seqRunner([timeout(), { stdout: okJson("late"), stderr: "", code: 0 }]);
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });
    await expect(
      provider.stream([{ role: "user", content: "edit" }], () => {}, { acceptEdits: true, cwd: "/wt" })
    ).rejects.toThrow(/timed out/);
    expect(count()).toBe(1); // ran exactly once
  });

  it("honors a per-call model override on the CLI --model arg", async () => {
    const { run } = fakeRunner({ stdout: okJson("x"), stderr: "", code: 0 });
    const provider = new ClaudeCliProvider({ authStrategy: stubStrategy, run });
    // capture via a wrapping runner
    const seen: string[][] = [];
    const recording: CliRunner = async (cli, args, input, cwd, t, onStdout) => {
      seen.push(args);
      return run(cli, args, input, cwd, t, onStdout);
    };
    const p2 = new ClaudeCliProvider({ authStrategy: stubStrategy, run: recording });
    await p2.send([{ role: "user", content: "hi" }], { model: "claude-sonnet-4-6" });
    expect(seen[0]).toContain("claude-sonnet-4-6");
  });
});

describe("parseStreamJson", () => {
  it("extracts the final result, usage, and model from the assistant turns", () => {
    const stdout = streamJson([{ text: "hi" }], "final answer", 3, 9);
    expect(parseStreamJson(stdout, "fallback")).toEqual({ content: "final answer", inputTokens: 3, outputTokens: 9, model: DEFAULT_MODEL });
  });

  it("throws on a non-success result subtype", () => {
    const stdout =
      JSON.stringify({ type: "assistant", message: { model: DEFAULT_MODEL, content: [{ type: "text", text: "…" }] } }) +
      "\n" +
      JSON.stringify({ type: "result", subtype: "error_max_turns", result: "ran out of turns" }) +
      "\n";
    expect(() => parseStreamJson(stdout, "m")).toThrow(/error_max_turns/);
  });

  it("falls back to assistant text and the fallback model when there is no result event", () => {
    const stdout = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }) + "\n";
    expect(parseStreamJson(stdout, "m-fallback")).toEqual({ content: "partial", inputTokens: 0, outputTokens: 0, model: "m-fallback" });
  });

  it("ignores malformed lines without throwing", () => {
    const stdout = "not json\n" + streamJson([{ text: "x" }], "ok");
    expect(parseStreamJson(stdout, "m").content).toBe("ok");
  });
});

describe("emitStreamChunk", () => {
  it("emits assistant text", () => {
    const out: string[] = [];
    emitStreamChunk(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking…" }] } }), (c) => out.push(c));
    expect(out).toEqual(["thinking…"]);
  });

  it("emits a compact tool-use line", () => {
    const out: string[] = [];
    emitStreamChunk(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a/b.ts" } }] } }), (c) => out.push(c));
    expect(out.join("")).toContain("→ Read a/b.ts");
  });

  it("ignores non-assistant, empty, and malformed lines", () => {
    const out: string[] = [];
    emitStreamChunk(JSON.stringify({ type: "result", result: "x" }), (c) => out.push(c));
    emitStreamChunk("", (c) => out.push(c));
    emitStreamChunk("{not json", (c) => out.push(c));
    expect(out).toEqual([]);
  });
});

describe("defaultCliRunner — timeout", () => {
  it("kills a wedged subprocess after timeoutMs and reports a timeout", async () => {
    // node sleeps far longer than the timeout; the runner must kill it and report.
    const res = await defaultCliRunner("node", ["-e", "setTimeout(() => {}, 60000)"], "", undefined, 300);
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/timed out after 300ms/);
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
