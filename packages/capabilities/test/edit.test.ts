import { describe, it, expect } from "vitest";

import { EditCapability, buildEditPrompt, parseEditPlan, safeResolve } from "../src/edit.js";
import type { CapabilityInput } from "../src/capability.js";
import type { Provider, Message } from "@bureau/providers";
import type { Step, StepId } from "@bureau/core";

const sid = (s: string) => s as unknown as StepId;

function fakeProvider(content: string): { provider: Provider; sent: Message[][] } {
  const sent: Message[][] = [];
  const provider: Provider = {
    name: "fake",
    authStrategy: { kind: "api-key", isAvailable: () => true },
    async send(messages) {
      sent.push(messages);
      return { content, inputTokens: 0, outputTokens: 0 };
    },
    async stream(messages, onChunk) {
      sent.push(messages);
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
  worktreePath: "/wt",
  context: "the goal",
  ...overrides,
});

describe("EditCapability.execute", () => {
  it("writes the planned files into the worktree and returns file artifacts", async () => {
    const plan = JSON.stringify({
      files: [
        { path: "src/hello.ts", content: "export const hello = () => 'hi';\n" },
        { path: "README.md", content: "# Hi\n" },
      ],
      summary: "add hello module",
    });
    const { provider } = fakeProvider(plan);
    const writes: { path: string; content: string }[] = [];

    const cap = new EditCapability({
      provider,
      writeFileFn: async (p, c) => void writes.push({ path: p, content: c }),
      ids: (() => {
        let n = 0;
        return () => `art-${++n}`;
      })(),
      clock: () => "2026-01-01T00:00:00.000Z",
    });

    const out = await cap.execute(input());

    expect(out.summary).toBe("add hello module");
    expect(out.artifacts).toEqual([
      { id: "art-1", kind: "file", ref: "src/hello.ts", producedByStep: "s1", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "art-2", kind: "file", ref: "README.md", producedByStep: "s1", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    // Files written under the worktree, with the model's content.
    expect(writes.map((w) => w.path)).toEqual([safeResolve("/wt", "src/hello.ts"), safeResolve("/wt", "README.md")]);
    expect(writes[0]!.content).toContain("export const hello");
  });

  it("refuses a path that escapes the worktree (traversal)", async () => {
    const plan = JSON.stringify({ files: [{ path: "../../etc/evil", content: "x" }], summary: "nope" });
    const { provider } = fakeProvider(plan);
    const cap = new EditCapability({ provider, writeFileFn: async () => {} });

    await expect(cap.execute(input())).rejects.toThrow(/outside the worktree/);
  });

  it("sends the change + context + criteria to the provider", async () => {
    const { provider, sent } = fakeProvider(JSON.stringify({ files: [], summary: "" }));
    const cap = new EditCapability({ provider, writeFileFn: async () => {} });
    await cap.execute(input());

    const userMsg = sent[0]!.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("add a greeting module");
    expect(userMsg).toContain("the goal");
    expect(userMsg).toContain("exports hello()");
    expect(sent[0]!.some((m) => m.role === "system")).toBe(true);
  });
});

describe("parseEditPlan", () => {
  it("parses a bare JSON object", () => {
    const plan = parseEditPlan('{"files":[{"path":"a.ts","content":"x"}],"summary":"s"}');
    expect(plan).toEqual({ files: [{ path: "a.ts", content: "x" }], summary: "s" });
  });

  it("tolerates surrounding prose / code fences", () => {
    const raw = "Sure!\n```json\n{\"files\":[{\"path\":\"a.ts\",\"content\":\"x\"}],\"summary\":\"s\"}\n```\nDone.";
    expect(parseEditPlan(raw).files).toEqual([{ path: "a.ts", content: "x" }]);
  });

  it("defaults summary to empty when missing", () => {
    expect(parseEditPlan('{"files":[]}').summary).toBe("");
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseEditPlan("no json here")).toThrow(/no JSON object/);
  });

  it("throws when files is not an array", () => {
    expect(() => parseEditPlan('{"summary":"s"}')).toThrow(/missing a `files` array/);
  });

  it("throws when a file lacks string path/content", () => {
    expect(() => parseEditPlan('{"files":[{"path":"a.ts"}]}')).toThrow(/string `path` and `content`/);
  });
});

describe("safeResolve", () => {
  it("resolves a relative path under the worktree", () => {
    expect(safeResolve("/wt", "src/a.ts")).toBe(safeResolve("/wt", "src/a.ts"));
    expect(() => safeResolve("/wt", "src/a.ts")).not.toThrow();
  });

  it("rejects traversal and absolute escapes", () => {
    expect(() => safeResolve("/wt", "../escape")).toThrow(/outside the worktree/);
    expect(() => safeResolve("/wt", "a/../../escape")).toThrow(/outside the worktree/);
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
