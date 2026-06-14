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
}

export interface SendOptions {
  readonly maxTokens?: number;
  /**
   * Working directory for an AGENTIC provider (the `claude` CLI). Any tool the
   * model runs is confined to this directory — for the `edit` capability it is
   * the task's isolated worktree, so the model can never read or touch files
   * outside it. Completion providers (Anthropic API) ignore it.
   */
  readonly cwd?: string;
}

export interface Provider {
  readonly name: string;
  readonly authStrategy: AuthStrategy;

  send(messages: Message[], options?: SendOptions): Promise<ProviderResponse>;

  stream(
    messages: Message[],
    onChunk: (chunk: string) => void,
    options?: SendOptions
  ): Promise<ProviderResponse>;

  // TODO: toolUse() — implement when capabilities need tool calls
}
