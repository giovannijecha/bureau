// Provider interface — capabilities call send/stream/toolUse, never know which model is live.

export type AuthStrategyKind = "api-key" | "cli-delegation" | "oauth";

export interface AuthStrategy {
  readonly kind: AuthStrategyKind;
  /** Returns false if unavailable (e.g. CLI not installed, oauth stub). Never throws. */
  isAvailable(): boolean;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ProviderResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** The model that produced this response — for usage/cost attribution. */
  model?: string;
}

export interface SendOptions {
  readonly maxTokens?: number;
  /** Override the model for THIS call (engine resolves it per scope); falls back to the
   *  provider's configured default. Lets chat run on a cheaper model than the workers. */
  readonly model?: string;
  /** Reasoning effort for THIS call (engine resolves it per scope). Native on BOTH paths:
   *  the claude CLI maps it to --effort, the Anthropic API to output_config.effort — the same
   *  vocabulary. Undefined ⇒ the model's default effort. (Inline union, not a @bureau/core
   *  import, so providers keeps its lean dependency surface.) */
  readonly effort?: "low" | "medium" | "high" | "xhigh";
  /**
   * Working directory for an AGENTIC provider (the `claude` CLI). Any tool the
   * model runs is confined to this directory — for the `edit` capability it is
   * the task's isolated worktree, so the model can never read or touch files
   * outside it. Completion providers (Anthropic API) ignore it.
   */
  readonly cwd?: string;
  /** Override the tool allowlist for this call (CLI provider). Defaults to read-only. */
  readonly tools?: readonly string[];
  /** Auto-accept file edits inside cwd (CLI provider) — for the agentic edit worker. */
  readonly acceptEdits?: boolean;
  /** Extra directories the CLI may READ from (--add-dir), beyond cwd — used to let
   *  Iris view chat image attachments saved outside the repo. Completion providers ignore it. */
  readonly addDirs?: readonly string[];
  /** Called once per tool the agent invokes during a streamed run, with a compact
   *  human summary (e.g. "Read src/auth.ts"). Lets the engine surface live "what Iris is
   *  doing" activity. Only fires on agentic streaming (the CLI provider); ignored otherwise. */
  readonly onToolUse?: (summary: string) => void;
}

export interface Provider {
  readonly name: string;
  readonly authStrategy: AuthStrategy;
  /**
   * True if the provider EXECUTES tools (reads/edits files) when given cwd/tools —
   * i.e. the agent does the work itself. The `edit` capability requires this. A
   * plain completion provider (Anthropic API) is NOT agentic.
   */
  readonly agentic?: boolean;

  send(messages: Message[], options?: SendOptions): Promise<ProviderResponse>;

  stream(
    messages: Message[],
    onChunk: (chunk: string) => void,
    options?: SendOptions
  ): Promise<ProviderResponse>;

  // TODO: toolUse() — implement when capabilities need tool calls
}
