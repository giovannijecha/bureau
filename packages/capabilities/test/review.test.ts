import { describe, it, expect } from "vitest";

import { ReviewCapability, buildReviewPrompt, REVIEW_TOOLS } from "../src/index.js";
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
  capability: "review",
  description: "review the change",
  acceptanceCriteria: [{ id: "c1", description: "no obvious bugs", verified: false }],
  status: "running",
  artifactIds: [],
  ...over,
});

const input = (over: Partial<CapabilityInput> = {}): CapabilityInput => ({
  step: step(),
  worktreePath: "/wt/task-1",
  context: "add a greeting",
  diff: "diff --git a/x b/x\n+hello",
  ...over,
});

describe("ReviewCapability", () => {
  it("runs READ-ONLY (no edit tools, acceptEdits off) in the worktree and is kind 'review'", async () => {
    const { provider, sent } = fakeProvider("Checked the diff.\nLooks good.");
    const cap = new ReviewCapability({ provider });
    expect(cap.kind).toBe("review");

    const out = await cap.execute(input());

    expect(out.summary).toBe("Looks good."); // last line = the verdict
    const opts = sent[0]!.opts!;
    expect(opts.cwd).toBe("/wt/task-1");
    expect(opts.acceptEdits).toBe(false); // never auto-accepts edits
    expect(opts.tools).toEqual([...REVIEW_TOOLS]);
    expect(opts.tools).not.toContain("Edit"); // cannot mutate
    expect(opts.tools).not.toContain("Write");
  });

  it("puts the goal, acceptance criteria, and the diff into the prompt", () => {
    const p = buildReviewPrompt(input());
    expect(p).toContain("add a greeting");
    expect(p).toContain("no obvious bugs");
    expect(p).toContain("+hello");
  });

  it("fails loud on a non-agentic provider", async () => {
    const { provider } = fakeProvider("x", false);
    await expect(new ReviewCapability({ provider }).execute(input())).rejects.toThrow(/agentic provider/);
  });
});
