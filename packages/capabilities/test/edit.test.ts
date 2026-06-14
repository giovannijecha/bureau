import { describe, it, expect } from "vitest";

import { EditCapability, buildEditPrompt, summarize, EDIT_TOOLS } from "../src/edit.js";
import type { CapabilityInput } from "../src/capability.js";
import type { Provider, Message, SendOptions } from "@bureau/providers";
import type { Step, StepId } from "@bureau/core";

const sid = (s: string) => s as unknown as StepId;

function fakeProvider(content: string): {
  provider: Provider;
  sent: { messages: Message[]; opts: SendOptions | undefined }[];
} {
  const sent: { messages: Message[]; opts: SendOptions | undefined }[] = [];
  const provider: Provider = {
    name: "fake",
    authStrategy: { kind: "cli-delegation", isAvailable: () => true },
    agentic: true,
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

const step = (overrides: Partial<Step> = {}): Step => ({
  id: sid("s1"),
  capability: "edit",
  description: "add a greeting module",
  acceptanceCriteria: [{ id: "c1", description: "exports hello()", verified: false }],
  status: "running",
  artifactIds: [],
  ...overrides,
});

const input = (overrides: Partial<CapabilityInput> = {}): CapabilityInput => ({
  step: step(),
  worktreePath: "/wt/task-1",
  context: "the goal",
  ...overrides,
});

describe("EditCapability.execute (agentic)", () => {
  it("runs the agent in the worktree with edit tools + acceptEdits, and returns a summary", async () => {
    const { provider, sent } = fakeProvider("Read README, then edited it.\nAdded a Status section to README.md.");
    const cap = new EditCapability({ provider });

    const out = await cap.execute(input());

    expect(out.artifacts).toEqual([]); // Bureau captures the diff, not the capability
    expect(out.summary).toBe("Added a Status section to README.md."); // last non-empty line

    const call = sent[0]!;
    expect(call.opts?.cwd).toBe("/wt/task-1"); // confined to the worktree
    expect(call.opts?.acceptEdits).toBe(true);
    expect(call.opts?.tools).toEqual([...EDIT_TOOLS]);
    expect(call.opts?.tools).toContain("Edit");
    expect(call.opts?.tools).toContain("Write");
    expect(call.opts?.tools).not.toContain("Bash"); // no arbitrary command execution

    const userMsg = call.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("add a greeting module");
    expect(userMsg).toContain("the goal");
    expect(userMsg).toContain("exports hello()");
  });
});

describe("buildEditPrompt", () => {
  it("includes description, context, and acceptance criteria", () => {
    const p = buildEditPrompt(input());
    expect(p).toContain("add a greeting module");
    expect(p).toContain("the goal");
    expect(p).toContain("exports hello()");
  });
});

describe("summarize", () => {
  it("takes the last non-empty line", () => {
    expect(summarize("doing stuff\n\nDone: added X.")).toBe("Done: added X.");
  });
  it("falls back when empty", () => {
    expect(summarize("   ")).toBe("Applied the requested change.");
  });
  it("truncates very long lines", () => {
    expect(summarize("x".repeat(300)).endsWith("...")).toBe(true);
  });
});
