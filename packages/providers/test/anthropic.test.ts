import { describe, it, expect, vi } from "vitest";

import {
  AnthropicProvider,
  splitMessages,
  toProviderResponse,
  DEFAULT_MODEL,
} from "../src/anthropic.js";
import type { Message } from "../src/provider.js";

const stubStrategy = { kind: "api-key" as const, isAvailable: () => true };

// A fake Anthropic SDK client that records the params it was called with and
// returns canned messages. Cast through `any` — tests run transpile-only.
function fakeClient(opts: {
  createReturn?: unknown;
  finalReturn?: unknown;
  deltas?: string[];
}) {
  const calls: { create?: any; stream?: any } = {};
  const client = {
    messages: {
      create: vi.fn(async (params: any) => {
        calls.create = params;
        return opts.createReturn;
      }),
      stream: vi.fn((params: any) => {
        calls.stream = params;
        return {
          on(event: string, cb: (delta: string) => void) {
            if (event === "text") (opts.deltas ?? []).forEach(cb);
            return this;
          },
          finalMessage: async () => opts.finalReturn,
        };
      }),
    },
  };
  return { client: client as any, calls };
}

const textMessage = (text: string, input = 11, output = 7) => ({
  content: [
    { type: "thinking", thinking: "internal" }, // must be filtered out
    { type: "text", text },
  ],
  usage: { input_tokens: input, output_tokens: output },
});

describe("AnthropicProvider — send", () => {
  it("extracts system messages, maps turns, and returns content + token usage", async () => {
    const { client, calls } = fakeClient({ createReturn: textMessage("hi there", 11, 7) });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });

    const messages: Message[] = [
      { role: "system", content: "be terse" },
      { role: "system", content: "speak Italian" },
      { role: "user", content: "ciao" },
    ];
    const res = await provider.send(messages);

    expect(res).toEqual({ content: "hi there", inputTokens: 11, outputTokens: 7 });
    expect(calls.create.model).toBe(DEFAULT_MODEL);
    expect(calls.create.max_tokens).toBe(16_000);
    expect(calls.create.system).toBe("be terse\n\nspeak Italian");
    expect(calls.create.messages).toEqual([{ role: "user", content: "ciao" }]);
  });

  it("omits the system field entirely when there are no system messages", async () => {
    const { client, calls } = fakeClient({ createReturn: textMessage("ok") });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });

    await provider.send([{ role: "user", content: "hello" }]);

    expect("system" in calls.create).toBe(false);
  });

  it("honors a custom model, name, and maxTokens override", async () => {
    const { client, calls } = fakeClient({ createReturn: textMessage("ok") });
    const provider = new AnthropicProvider({
      authStrategy: stubStrategy,
      client,
      model: "claude-haiku-4-5",
      name: "fast-lane",
    });

    expect(provider.name).toBe("fast-lane");
    await provider.send([{ role: "user", content: "hi" }], { maxTokens: 256 });
    expect(calls.create.model).toBe("claude-haiku-4-5");
    expect(calls.create.max_tokens).toBe(256);
  });

  it("derives a default name from the model", () => {
    const { client } = fakeClient({ createReturn: textMessage("ok") });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    expect(provider.name).toBe(`anthropic:${DEFAULT_MODEL}`);
  });

  it("honors a per-call model override (options.model)", async () => {
    const { client, calls } = fakeClient({ createReturn: textMessage("ok") });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    await provider.send([{ role: "user", content: "hi" }], { model: "claude-sonnet-4-6" });
    expect(calls.create.model).toBe("claude-sonnet-4-6");
  });
});

describe("AnthropicProvider — refusal / truncation / retry (reliability)", () => {
  it("throws on a refusal stop_reason — never a phantom success", async () => {
    const { client } = fakeClient({ createReturn: { ...textMessage(""), stop_reason: "refusal" } });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    await expect(provider.send([{ role: "user", content: "x" }])).rejects.toThrow(/refus|declined/i);
  });

  it("throws on a refusal content block", async () => {
    const { client } = fakeClient({ createReturn: { content: [{ type: "refusal" }], usage: { input_tokens: 1, output_tokens: 0 } } });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    await expect(provider.send([{ role: "user", content: "x" }])).rejects.toThrow(/refus|declined/i);
  });

  it("throws on a max_tokens truncation — an incomplete result must not pass", async () => {
    const { client } = fakeClient({ createReturn: { ...textMessage("partial"), stop_reason: "max_tokens" } });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    await expect(provider.send([{ role: "user", content: "x" }])).rejects.toThrow(/cut off|incomplete|max_tokens/i);
  });

  it("a normal end_turn still resolves", async () => {
    const { client } = fakeClient({ createReturn: { ...textMessage("done"), stop_reason: "end_turn" } });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    expect((await provider.send([{ role: "user", content: "x" }])).content).toBe("done");
  });

  it("retries a transient 5xx, then succeeds", async () => {
    let n = 0;
    const client: any = {
      messages: {
        create: vi.fn(async () => {
          if (n++ < 2) {
            const e: any = new Error("overloaded");
            e.status = 529;
            throw e;
          }
          return textMessage("ok");
        }),
      },
    };
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    expect((await provider.send([{ role: "user", content: "x" }])).content).toBe("ok");
    expect(client.messages.create).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a 4xx — fails on the first call", async () => {
    const client: any = {
      messages: {
        create: vi.fn(async () => {
          const e: any = new Error("bad request");
          e.status = 400;
          throw e;
        }),
      },
    };
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });
    await expect(provider.send([{ role: "user", content: "x" }])).rejects.toThrow(/bad request/);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });
});

describe("AnthropicProvider — stream", () => {
  it("forwards text deltas to onChunk and returns the final message's totals", async () => {
    const { client, calls } = fakeClient({
      deltas: ["Hel", "lo!"],
      finalReturn: textMessage("Hello!", 4, 2),
    });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });

    const chunks: string[] = [];
    const res = await provider.stream([{ role: "user", content: "hi" }], (c) => chunks.push(c));

    expect(chunks).toEqual(["Hel", "lo!"]);
    expect(res).toEqual({ content: "Hello!", inputTokens: 4, outputTokens: 2 });
    expect(calls.stream.max_tokens).toBe(64_000); // streaming default
  });
});

describe("AnthropicProvider — input validation", () => {
  it("rejects an empty or system-only message list before calling the SDK", async () => {
    const { client, calls } = fakeClient({ createReturn: textMessage("x") });
    const provider = new AnthropicProvider({ authStrategy: stubStrategy, client });

    await expect(provider.send([])).rejects.toThrow(/at least one user\/assistant message/);
    await expect(provider.send([{ role: "system", content: "only" }])).rejects.toThrow(/at least one/);
    expect(calls.create).toBeUndefined(); // never reached the SDK
  });
});

describe("splitMessages", () => {
  it("joins multiple system messages and keeps user/assistant order", () => {
    const { system, turns } = splitMessages([
      { role: "system", content: "a" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "system", content: "b" },
      { role: "user", content: "u2" },
    ]);
    expect(system).toBe("a\n\nb");
    expect(turns).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]);
  });

  it("returns undefined system when none present", () => {
    expect(splitMessages([{ role: "user", content: "x" }]).system).toBeUndefined();
  });
});

describe("toProviderResponse", () => {
  it("concatenates only text blocks and reads usage", () => {
    const res = toProviderResponse({
      content: [
        { type: "text", text: "foo " },
        { type: "tool_use", id: "t", name: "x", input: {} },
        { type: "text", text: "bar" },
      ],
      usage: { input_tokens: 3, output_tokens: 9 },
    } as any);
    expect(res).toEqual({ content: "foo bar", inputTokens: 3, outputTokens: 9 });
  });
});
