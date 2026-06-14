// Claude CLI provider — the cli-delegation path. Shells out to the local
// `claude` binary instead of calling the HTTP API with a key. The subprocess
// RUNNER is injectable so this is unit-testable without the CLI installed.
//
// Phase 1 scope: send() does one `claude -p --output-format json` round-trip and
// parses the result + token usage. stream() falls back to send() and emits the
// whole answer as a single chunk (true CLI streaming is a later phase).

import { spawn } from "node:child_process";
import type { Provider, AuthStrategy, Message, ProviderResponse, SendOptions } from "./provider.js";
import { DEFAULT_MODEL } from "./anthropic.js";

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type CliRunner = (
  cli: string,
  args: string[],
  input: string,
  cwd?: string,
  timeoutMs?: number
) => Promise<CliResult>;

/** Default runner: spawn the CLI, feed the prompt on stdin, collect stdout. The
 *  CLI runs in `cwd` (the task's worktree for edits) so its tools can't reach
 *  outside it. A wedged subprocess is killed after `timeoutMs` so a hung edit can
 *  never block a pipeline forever. */
export const defaultCliRunner: CliRunner = (cli, args, input, cwd, timeoutMs) =>
  new Promise<CliResult>((resolve) => {
    const child = spawn(cli, args, { stdio: ["pipe", "pipe", "pipe"], ...(cwd !== undefined ? { cwd } : {}) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2000).unref(); // hard-kill if it ignores SIGTERM
          }, timeoutMs)
        : undefined;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: "", stderr: String(err), code: -1 });
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve(
        timedOut
          ? { stdout, stderr: `claude CLI timed out after ${timeoutMs}ms`, code: -1 }
          : { stdout, stderr, code: code ?? -1 }
      );
    });
    child.stdin.end(input);
  });

/**
 * The ONLY tools the CLI may use — strictly read-only. The `claude` binary is an
 * autonomous agent; without this it would use Edit/Write/Bash to mutate files
 * directly (in the wrong place, with non-deterministic results). Bureau owns all
 * mutation: the model returns a plan, the capability writes it into the worktree.
 */
export const READONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

export interface ClaudeCliProviderOptions {
  readonly authStrategy: AuthStrategy;
  readonly run?: CliRunner;
  readonly cli?: string;
  readonly model?: string;
  readonly name?: string;
  /** Override the tool allowlist (tests). Defaults to read-only — do NOT add write tools. */
  readonly tools?: readonly string[];
  /** Kill the CLI subprocess after this many ms (0 disables). Default 4 minutes. */
  readonly timeoutMs?: number;
}

/** Default subprocess timeout — long enough for a real edit, short enough that a
 *  wedged CLI doesn't park a pipeline indefinitely. */
export const DEFAULT_CLI_TIMEOUT_MS = 240_000;

export class ClaudeCliProvider implements Provider {
  readonly name: string;
  readonly authStrategy: AuthStrategy;
  private readonly run: CliRunner;
  private readonly cli: string;
  private readonly model: string;
  private readonly tools: readonly string[];
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliProviderOptions) {
    this.authStrategy = opts.authStrategy;
    this.run = opts.run ?? defaultCliRunner;
    this.cli = opts.cli ?? "claude";
    this.model = opts.model ?? DEFAULT_MODEL;
    this.tools = opts.tools ?? READONLY_TOOLS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.name = opts.name ?? `claude-cli:${this.model}`;
  }

  async send(messages: Message[], options?: SendOptions): Promise<ProviderResponse> {
    if (!messages.some((m) => m.role !== "system")) {
      throw new Error("ClaudeCliProvider.send requires at least one user/assistant message.");
    }
    const { system, prompt } = renderCliPrompt(messages);
    const tools = options?.tools ?? this.tools;
    const args = ["-p", "--output-format", "json", "--model", this.model];
    if (system !== undefined) args.push("--system-prompt", system);
    if (options?.acceptEdits) {
      // The edit worker: auto-accept file edits, but only inside the working dir.
      args.push("--permission-mode", "acceptEdits");
      if (options.cwd !== undefined) args.push("--add-dir", options.cwd);
    }
    // Tool allowlist LAST (variadic --tools consumes the rest).
    if (tools.length > 0) args.push("--tools", ...tools);

    const { stdout, stderr, code } = await this.run(this.cli, args, prompt, options?.cwd, this.timeoutMs);
    if (code !== 0) {
      throw new Error(`claude CLI exited with code ${code}: ${stderr.trim() || "(no stderr)"}`);
    }
    return parseCliJson(stdout);
  }

  async stream(
    messages: Message[],
    onChunk: (chunk: string) => void,
    options?: SendOptions
  ): Promise<ProviderResponse> {
    // Phase 1: no incremental CLI streaming yet — deliver the full answer once.
    const result = await this.send(messages, options);
    if (result.content) onChunk(result.content); // never emit an empty chunk (matches AnthropicProvider)
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Split system out (passed via --system-prompt) and render turns into one prompt. */
export function renderCliPrompt(messages: Message[]): { system: string | undefined; prompt: string } {
  const systemParts: string[] = [];
  const turns: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else turns.push(m);
  }
  const prompt =
    turns.length === 1
      ? (turns[0]?.content ?? "")
      : turns.map((t) => `${t.role === "user" ? "Human" : "Assistant"}: ${t.content}`).join("\n\n");
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    prompt,
  };
}

/** Parse `claude --output-format json` stdout into a ProviderResponse. */
export function parseCliJson(stdout: string): ProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  const obj = parsed as {
    result?: unknown;
    is_error?: unknown;
    subtype?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  // The CLI exits 0 even when the run itself failed (max turns, in-session error)
  // — it signals that via is_error, not the exit code. Surface it as a real
  // failure so a capability never treats an error string as model output.
  if (obj.is_error === true) {
    const detail = typeof obj.result === "string" ? obj.result.slice(0, 200) : "(no detail)";
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "unknown";
    throw new Error(`claude CLI reported an error (${subtype}): ${detail}`);
  }
  return {
    content: typeof obj.result === "string" ? obj.result : "",
    inputTokens: typeof obj.usage?.input_tokens === "number" ? obj.usage.input_tokens : 0,
    outputTokens: typeof obj.usage?.output_tokens === "number" ? obj.usage.output_tokens : 0,
  };
}
