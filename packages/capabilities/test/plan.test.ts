import { describe, it, expect } from "vitest";

import { PlanCapability, buildPlanPrompt, PLAN_TOOLS } from "../src/index.js";
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
  capability: "plan",
  description: "plan the change",
  acceptanceCriteria: [{ id: "c1", description: "addNumbers exists" }],
  status: "running",
  artifactIds: [],
  ...over,
});

const input = (over: Partial<CapabilityInput> = {}): CapabilityInput => ({
  step: step(),
  worktreePath: "/wt/task-1",
  context: "add an add() helper",
  ...over,
});

describe("PlanCapability", () => {
  it("runs READ-ONLY (Read/Glob/Grep, acceptEdits off) and is kind 'plan'", async () => {
    const { provider, sent } = fakeProvider("Plan:\n- edit math.js\n- export add(a,b)");
    const cap = new PlanCapability({ provider });
    expect(cap.kind).toBe("plan");

    await cap.execute(input());
    const opts = sent[0]!.opts!;
    expect(opts.acceptEdits).toBe(false);
    expect(opts.tools).toEqual([...PLAN_TOOLS]);
    expect(opts.tools).not.toContain("Edit");
    expect(opts.tools).not.toContain("Write");
  });

  it("keeps the WHOLE plan as the summary (not just the last line) so later steps can follow it", async () => {
    const { provider } = fakeProvider("Plan:\n- edit math.js\n- export add(a,b)");
    const out = await new PlanCapability({ provider }).execute(input());
    expect(out.summary).toContain("edit math.js");
    expect(out.summary).toContain("export add(a,b)"); // the full multi-line plan, not only the last line
  });

  it("puts the goal + acceptance criteria into the prompt", () => {
    const p = buildPlanPrompt(input());
    expect(p).toContain("add an add() helper");
    expect(p).toContain("addNumbers exists");
  });

  it("fails loud on a non-agentic provider", async () => {
    const { provider } = fakeProvider("x", false);
    await expect(new PlanCapability({ provider }).execute(input())).rejects.toThrow(/agentic provider/);
  });
});
