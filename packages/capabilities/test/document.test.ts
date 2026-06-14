import { describe, it, expect } from "vitest";

import { DocumentCapability, EDIT_TOOLS } from "../src/index.js";
import type { CapabilityInput } from "../src/capability.js";
import type { Provider, Message, SendOptions } from "@bureau/providers";
import type { Step, StepId } from "@bureau/core";

const sid = (s: string) => s as unknown as StepId;

function fakeProvider(content: string, agentic = true) {
  const sent: { messages: Message[]; opts: SendOptions | undefined }[] = [];
  const provider: Provider = {
    name: "fake",
    authStrategy: { kind: "cli-delegation", isAvailable: () => true },
    agentic,
    async send(messages, opts) {
      sent.push({ messages, opts });
      return { content, inputTokens: 0, outputTokens: 0 };
    },
    async stream(messages, onChunk, opts) {
      sent.push({ messages, opts });
      onChunk(content);
      return { content, inputTokens: 0, outputTokens: 0 };
    },
  };
  return { provider, sent };
}

const step = (over: Partial<Step> = {}): Step => ({
  id: sid("s1"),
  capability: "document",
  description: "document the change in the README",
  acceptanceCriteria: [],
  status: "running",
  artifactIds: [],
  ...over,
});

const input = (over: Partial<CapabilityInput> = {}): CapabilityInput => ({
  step: step(),
  worktreePath: "/wt/task-1",
  context: "the goal",
  ...over,
});

describe("DocumentCapability", () => {
  it("runs agentically in the worktree (cwd + acceptEdits + edit tools) and is kind 'document'", async () => {
    const { provider, sent } = fakeProvider("Documented the change.\nUpdated README with a Status note.");
    const cap = new DocumentCapability({ provider });
    expect(cap.kind).toBe("document");

    const out = await cap.execute(input());

    expect(out.artifacts).toEqual([]);
    expect(out.summary).toBe("Updated README with a Status note.");
    const call = sent[0]!;
    expect(call.opts).toMatchObject({ cwd: "/wt/task-1", acceptEdits: true, tools: [...EDIT_TOOLS] });
    expect(call.messages.find((m) => m.role === "system")!.content).toContain("document");
  });

  it("fails loud on a non-agentic (completion) provider instead of a silent no-op", async () => {
    const { provider } = fakeProvider("text", false);
    const cap = new DocumentCapability({ provider });
    await expect(cap.execute(input())).rejects.toThrow(/agentic provider/);
  });
});
