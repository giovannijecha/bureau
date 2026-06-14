// Anthropic adapter — the api-key path. Wraps the official @anthropic-ai/sdk.
//
// The SDK client is INJECTED (not constructed here) so this stays unit-testable
// with a fake transport and so the engine owns key resolution: it reads the
// api-key from a secret_ref, builds `new Anthropic({ apiKey })`, and passes it.
//
// Default model is claude-opus-4-8 (Anthropic's current Opus). Thinking/effort
// are intentionally not set at this transport layer in Phase 1 — capabilities
// can thread them through later via options.

import type Anthropic from "@anthropic-ai/sdk";
import type { Provider, AuthStrategy, Message, ProviderResponse, SendOptions } from "./provider.js";

export const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 16_000; // non-streaming: stay under SDK HTTP timeouts
const DEFAULT_STREAM_MAX_TOKENS = 64_000; // streaming: give the model room

export interface AnthropicProviderOptions {
  readonly authStrategy: AuthStrategy;
  /** A constructed Anthropic SDK client (or any structurally-compatible fake). */
  readonly client: Anthropic;
  readonly model?: string;
  readonly name?: string;
}

export class AnthropicProvider implements Provider {
  readonly name: string;
  readonly authStrategy: AuthStrategy;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicProviderOptions) {
    this.authStrategy = opts.authStrategy;
    this.client = opts.client;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.name = opts.name ?? `anthropic:${this.model}`;
  }

  async send(messages: Message[], options?: SendOptions): Promise<ProviderResponse> {
    const { system, turns } = splitMessages(messages);
    assertHasTurn(turns);
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system !== undefined ? { system } : {}),
      messages: turns,
    });
    return toProviderResponse(message);
  }

  async stream(
    messages: Message[],
    onChunk: (chunk: string) => void,
    options?: SendOptions
  ): Promise<ProviderResponse> {
    const { system, turns } = splitMessages(messages);
    assertHasTurn(turns);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options?.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS,
      ...(system !== undefined ? { system } : {}),
      messages: turns,
    });
    stream.on("text", (delta: string) => onChunk(delta));
    const final = await stream.finalMessage();
    return toProviderResponse(final);
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** The Anthropic API rejects an empty messages[]; fail locally with a clear error. */
function assertHasTurn(turns: Anthropic.MessageParam[]): void {
  if (turns.length === 0) {
    throw new Error(
      "AnthropicProvider requires at least one user/assistant message (system-only is not a valid request)."
    );
  }
}

/**
 * The Anthropic API takes the system prompt as a top-level field, not as a
 * message role. Pull every "system" message out into a single joined string and
 * pass the remaining user/assistant turns through unchanged.
 */
export function splitMessages(messages: Message[]): {
  system: string | undefined;
  turns: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const turns: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else turns.push({ role: m.role, content: m.content });
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    turns,
  };
}

/** Flatten an Anthropic message into the provider-neutral response shape. */
export function toProviderResponse(message: Anthropic.Message): ProviderResponse {
  const content = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    content,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
