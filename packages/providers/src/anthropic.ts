// Anthropic adapter — the api-key path. Wraps the official @anthropic-ai/sdk.
//
// The SDK client is INJECTED (not constructed here) so this stays unit-testable
// with a fake transport and so the engine owns key resolution: it reads the
// api-key from a secret_ref, builds `new Anthropic({ apiKey })`, and passes it.
//
// Default model is claude-opus-4-8 (Anthropic's current Opus). Reasoning effort is
// threaded per-call via options.effort → output_config.effort (the same low/medium/high/
// xhigh vocabulary the claude CLI uses); omitted ⇒ the model's default effort.

import type Anthropic from "@anthropic-ai/sdk";
import type { Provider, AuthStrategy, Message, ProviderResponse, SendOptions } from "./provider.js";
import { ProviderError, isRetryableError } from "./errors.js";
import { withRetry } from "./retry.js";

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
  readonly agentic = false; // plain completion — no tool execution, cannot edit files
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
    // Retry only the network round-trip on transient failures; toProviderResponse
    // (which throws on a refusal/truncation) runs OUTSIDE the retry so those are never
    // retried — they aren't transient.
    const message = await withRetry(
      () =>
        this.client.messages.create({
          model: options?.model ?? this.model,
          max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(options?.effort !== undefined ? { output_config: { effort: options.effort } } : {}),
          ...(system !== undefined ? { system } : {}),
          messages: turns,
        }),
      { isRetryable: isRetryableError }
    );
    return toProviderResponse(message);
  }

  async stream(
    messages: Message[],
    onChunk: (chunk: string) => void,
    options?: SendOptions
  ): Promise<ProviderResponse> {
    const { system, turns } = splitMessages(messages);
    assertHasTurn(turns);
    // A retried stream re-creates the stream and re-emits its text deltas; that's
    // harmless (only the final summary is persisted) — the engine never double-counts.
    const final = await withRetry(async () => {
      const stream = this.client.messages.stream({
        model: options?.model ?? this.model,
        max_tokens: options?.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS,
        ...(options?.effort !== undefined ? { output_config: { effort: options.effort } } : {}),
        ...(system !== undefined ? { system } : {}),
        messages: turns,
      });
      stream.on("text", (delta: string) => onChunk(delta));
      return stream.finalMessage();
    }, { isRetryable: isRetryableError });
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

/**
 * Flatten an Anthropic message into the provider-neutral response shape — but FAIL LOUD
 * on a non-success outcome a worker must never treat as a real result: a refusal
 * (stop_reason 'refusal' or a refusal content block) or a truncation (stop_reason
 * 'max_tokens', which would hand a worker an incomplete edit). These throw a typed
 * ProviderError (non-retryable). end_turn / stop_sequence / tool_use / pause_turn are
 * treated as success (pause_turn returns partial content only with server-side tools,
 * which Bureau doesn't use yet — revisit if that changes).
 */
export function toProviderResponse(message: Anthropic.Message): ProviderResponse {
  const hasRefusalBlock = message.content.some((b) => (b as { type?: string }).type === "refusal");
  if (message.stop_reason === "refusal" || hasRefusalBlock) {
    throw new ProviderError("The model declined to complete this request (refusal).", { kind: "refusal" });
  }
  if (message.stop_reason === "max_tokens") {
    throw new ProviderError("The model response was cut off (max_tokens) — the output is incomplete.", { kind: "truncated" });
  }
  const content = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    content,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    model: message.model,
  };
}
