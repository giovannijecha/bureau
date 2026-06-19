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
import { ProviderError, isRetryableError } from "./errors.js";
import { withRetry } from "./retry.js";

/** Stderr prefix the runner stamps on a timeout, so the retry layer can classify a
 *  timed-out run as transient (retryable for read-only calls) vs a real CLI error. */
export const CLI_TIMEOUT_SENTINEL = "BUREAU_CLI_TIMEOUT ";

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
  timeoutMs?: number,
  /** Called with each raw stdout chunk as it arrives — for incremental streaming. */
  onStdout?: (chunk: string) => void
) => Promise<CliResult>;

/** Default runner: spawn the CLI, feed the prompt on stdin, collect stdout. The
 *  CLI runs in `cwd` (the task's worktree for edits) so its tools can't reach
 *  outside it. A wedged subprocess is killed after `timeoutMs` so a hung edit can
 *  never block a pipeline forever. */
export const defaultCliRunner: CliRunner = (cli, args, input, cwd, timeoutMs, onStdout) =>
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
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      onStdout?.(s);
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => {
      if (timer) clearTimeout(timer);
      // If we already fired the kill timer, this error is the teardown of a TIMEOUT —
      // stamp the sentinel so it's classified transient (retryable), like the close path.
      resolve(timedOut ? { stdout, stderr: `${CLI_TIMEOUT_SENTINEL}${String(err)}`, code: -1 } : { stdout: "", stderr: String(err), code: -1 });
    });
    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve(
        timedOut
          ? { stdout, stderr: `${CLI_TIMEOUT_SENTINEL}claude CLI timed out after ${timeoutMs}ms`, code: -1 }
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
  /** Kill the CLI subprocess after this many ms (0 disables) for READ-ONLY calls. Default 4 min. */
  readonly timeoutMs?: number;
  /** Same, for the EDIT worker (acceptEdits). It never retries and a big edit needs more —
   *  default 10 min. Kept under the orchestrator's per-step backstop. */
  readonly editTimeoutMs?: number;
}

/** Default subprocess timeout for READ-ONLY calls (plan/review/research/chat) — these
 *  retry transient failures, so the orchestrator's per-step backstop must clear 3× this. */
export const DEFAULT_CLI_TIMEOUT_MS = 240_000;

/** Default subprocess timeout for the EDIT worker. An edit isn't retried (re-running could
 *  double-apply a partial edit), so it gets ONE shot — and a substantial change (e.g. a full
 *  scaffold rewrite) legitimately needs more than the read-only budget. Kept comfortably
 *  under the orchestrator's per-step backstop (STEP_TIMEOUT_MS, 15 min) since it never retries. */
export const DEFAULT_EDIT_TIMEOUT_MS = 600_000;

export class ClaudeCliProvider implements Provider {
  readonly name: string;
  readonly authStrategy: AuthStrategy;
  readonly agentic = true; // the CLI executes Read/Edit/Write in the worktree itself
  private readonly run: CliRunner;
  private readonly cli: string;
  private readonly model: string;
  private readonly tools: readonly string[];
  private readonly timeoutMs: number;
  private readonly editTimeoutMs: number;

  constructor(opts: ClaudeCliProviderOptions) {
    this.authStrategy = opts.authStrategy;
    this.run = opts.run ?? defaultCliRunner;
    this.cli = opts.cli ?? "claude";
    this.model = opts.model ?? DEFAULT_MODEL;
    this.tools = opts.tools ?? READONLY_TOOLS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.editTimeoutMs = opts.editTimeoutMs ?? DEFAULT_EDIT_TIMEOUT_MS;
    this.name = opts.name ?? `claude-cli:${this.model}`;
  }

  /** The edit worker (acceptEdits, no retry) gets the longer budget; read-only the shorter. */
  private timeoutFor(options?: SendOptions): number {
    return options?.acceptEdits ? this.editTimeoutMs : this.timeoutMs;
  }

  async send(messages: Message[], options?: SendOptions): Promise<ProviderResponse> {
    if (!messages.some((m) => m.role !== "system")) {
      throw new Error("ClaudeCliProvider.send requires at least one user/assistant message.");
    }
    const { system, prompt } = renderCliPrompt(messages);
    const tools = options?.tools ?? this.tools;
    const args = ["-p", "--output-format", "json", "--model", options?.model ?? this.model];
    // Reasoning effort (--effort is a global flag valid in -p mode). Fixed enum value, argv-only.
    if (options?.effort) args.push("--effort", options.effort);
    // Append (don't replace) so Claude Code's default tool/safety guidance is kept.
    if (system !== undefined) args.push("--append-system-prompt", system);
    if (options?.acceptEdits) {
      // The edit worker: auto-accept file edits, but only inside the working dir.
      args.push("--permission-mode", "acceptEdits");
      if (options.cwd !== undefined) args.push("--add-dir", options.cwd);
    }
    // Extra read-only dirs (e.g. chat image attachments) — before the variadic --tools.
    for (const dir of options?.addDirs ?? []) args.push("--add-dir", dir);
    // Tool allowlist LAST (variadic --tools consumes the rest).
    if (tools.length > 0) args.push("--tools", ...tools);

    const exec = async (): Promise<ProviderResponse> => {
      const { stdout, stderr, code } = await this.run(this.cli, args, prompt, options?.cwd, this.timeoutFor(options));
      if (code !== 0) throw cliExitError(code, stderr);
      const result = parseCliJson(stdout);
      // The CLI reports the model it used; fall back to the configured one.
      return { ...result, model: result.model ?? (options?.model ?? this.model) };
    };
    // The edit worker (acceptEdits) is NEVER retried — re-running could double-apply a
    // partial edit. Read-only calls (plan/review/research/chat) retry transient failures.
    // retries:2 keeps the worst case (≤3 × the 240s self-timeout) under the orchestrator's
    // per-step backstop so a slow retry can actually complete instead of being killed.
    return options?.acceptEdits ? exec() : withRetry(exec, { isRetryable: isRetryableError, retries: 2 });
  }

  async stream(
    messages: Message[],
    onChunk: (chunk: string) => void,
    options?: SendOptions
  ): Promise<ProviderResponse> {
    if (!messages.some((m) => m.role !== "system")) {
      throw new Error("ClaudeCliProvider.stream requires at least one user/assistant message.");
    }
    const { system, prompt } = renderCliPrompt(messages);
    const tools = options?.tools ?? this.tools;
    const model = options?.model ?? this.model;
    // stream-json emits newline-delimited events as the agent works; -p mode
    // requires --verbose with it. The edit flags (acceptEdits/add-dir/tools) all
    // still apply — only the output FORMAT differs from send().
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model];
    if (options?.effort) args.push("--effort", options.effort);
    if (system !== undefined) args.push("--append-system-prompt", system);
    if (options?.acceptEdits) {
      args.push("--permission-mode", "acceptEdits");
      if (options.cwd !== undefined) args.push("--add-dir", options.cwd);
    }
    for (const dir of options?.addDirs ?? []) args.push("--add-dir", dir);
    if (tools.length > 0) args.push("--tools", ...tools);

    const exec = async (): Promise<ProviderResponse> => {
      // Translate each COMPLETE json line into a human progress chunk as it arrives.
      // stdout chunks don't align to line boundaries, so buffer until a newline. The
      // buffer is per-attempt (declared here) so a retry starts clean.
      let buffer = "";
      const onStdout = (chunk: string): void => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          emitStreamChunk(line, onChunk, options?.onToolUse);
        }
      };
      const { stdout, stderr, code } = await this.run(this.cli, args, prompt, options?.cwd, this.timeoutFor(options), onStdout);
      if (code !== 0) throw cliExitError(code, stderr);
      return parseStreamJson(stdout, model);
    };
    // Edit worker: run once (never re-run a possibly-partial edit). Read-only: retry
    // (retries:2 — see send() — bounds the worst case under the per-step backstop).
    return options?.acceptEdits ? exec() : withRetry(exec, { isRetryable: isRetryableError, retries: 2 });
  }
}

/** A non-zero CLI exit → a typed error. A timeout (stamped with the sentinel) is
 *  TRANSIENT (retryable for read-only calls); any other non-zero exit is PERMANENT
 *  (a real CLI error/refusal the retry layer must not re-run). */
function cliExitError(code: number, stderr: string): ProviderError {
  const timedOut = stderr.startsWith(CLI_TIMEOUT_SENTINEL);
  return new ProviderError(
    `claude CLI ${timedOut ? "timed out" : `exited with code ${code}`}: ${stderr.trim() || "(no stderr)"}`,
    { kind: timedOut ? "transient" : "permanent" }
  );
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

/**
 * Emit a human progress chunk from ONE stream-json line (assistant text + a compact
 * line per tool call). Best-effort — empty, partial, or unknown lines are ignored,
 * never thrown, so a single odd frame can't break a live edit. When `onToolUse` is
 * given, each tool call is ALSO surfaced as a structured summary (for live "what the
 * agent is doing" activity, distinct from the text stream).
 */
export function emitStreamChunk(
  line: string,
  onChunk: (chunk: string) => void,
  onToolUse?: (summary: string) => void
): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let ev: unknown;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return; // a partial / non-JSON frame
  }
  const obj = ev as { type?: unknown; message?: { content?: unknown } };
  if (obj.type !== "assistant" || !obj.message || !Array.isArray(obj.message.content)) return;
  for (const block of obj.message.content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      onChunk(block.text);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const summary = describeTool(block.name, block.input);
      onChunk(`\n→ ${summary}\n`);
      onToolUse?.(summary);
    }
  }
}

/** A compact one-line description of a tool call for the live stream. */
function describeTool(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const i = input as Record<string, unknown>;
    const path = i.file_path ?? i.path ?? i.notebook_path;
    if (typeof path === "string") return `${name} ${path}`;
    if (typeof i.command === "string") return `${name}: ${i.command.slice(0, 80)}`;
    if (typeof i.pattern === "string") return `${name} "${String(i.pattern).slice(0, 60)}"`;
  }
  return name;
}

/**
 * Parse the FULL stream-json output into a ProviderResponse. The final `result`
 * event carries the answer text + token usage; the model comes from the assistant
 * events. Falls back to the concatenated assistant text if there's no result event.
 * Surfaces a CLI-reported error (non-success subtype / is_error) as a thrown error,
 * mirroring parseCliJson — a capability must never treat an error string as output.
 */
export function parseStreamJson(stdout: string, fallbackModel: string): ProviderResponse {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;
  const textParts: string[] = [];

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = ev as {
      type?: unknown;
      subtype?: unknown;
      is_error?: unknown;
      result?: unknown;
      message?: { model?: unknown; content?: unknown };
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (obj.type === "assistant" && obj.message) {
      if (typeof obj.message.model === "string") model = obj.message.model;
      if (Array.isArray(obj.message.content)) {
        for (const b of obj.message.content as Array<Record<string, unknown>>) {
          if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
        }
      }
    } else if (obj.type === "result") {
      if (obj.is_error === true || (typeof obj.subtype === "string" && obj.subtype !== "success")) {
        const detail = typeof obj.result === "string" ? obj.result.slice(0, 200) : String(obj.subtype ?? "error");
        // A CLI-reported error (refusal / max-turns / in-session error) is NOT transient.
        throw new ProviderError(`claude CLI reported an error (${String(obj.subtype ?? "error")}): ${detail}`, { kind: "permanent" });
      }
      if (typeof obj.result === "string") content = obj.result;
      if (typeof obj.usage?.input_tokens === "number") inputTokens = obj.usage.input_tokens;
      if (typeof obj.usage?.output_tokens === "number") outputTokens = obj.usage.output_tokens;
    }
  }

  return { content: content || textParts.join(""), inputTokens, outputTokens, model: model ?? fallbackModel };
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
    model?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  // The CLI exits 0 even when the run itself failed (max turns, in-session error)
  // — it signals that via is_error, not the exit code. Surface it as a real
  // failure so a capability never treats an error string as model output.
  if (obj.is_error === true) {
    const detail = typeof obj.result === "string" ? obj.result.slice(0, 200) : "(no detail)";
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "unknown";
    // A CLI-reported error is NOT transient — don't let the retry layer re-run it.
    throw new ProviderError(`claude CLI reported an error (${subtype}): ${detail}`, { kind: "permanent" });
  }
  return {
    content: typeof obj.result === "string" ? obj.result : "",
    inputTokens: typeof obj.usage?.input_tokens === "number" ? obj.usage.input_tokens : 0,
    outputTokens: typeof obj.usage?.output_tokens === "number" ? obj.usage.output_tokens : 0,
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
  };
}
