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

export interface Provider {
  readonly name: string;
  readonly authStrategy: AuthStrategy;

  send(messages: Message[], options?: { maxTokens?: number }): Promise<ProviderResponse>;

  stream(
    messages: Message[],
    onChunk: (chunk: string) => void,
    options?: { maxTokens?: number }
  ): Promise<ProviderResponse>;

  // TODO: toolUse() — implement when capabilities need tool calls
}
