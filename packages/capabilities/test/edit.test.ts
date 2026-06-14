import { describe, it, expect } from "vitest";

import { mkdtemp, writeFile, readFile as readFileFs, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EditCapability, buildEditPrompt, summarize, EDIT_TOOLS, applyFileOps, OPS_FILE } from "../src/edit.js";
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
    expect(call.opts?.tools).not.toContain("Bash"); // NO shell — deletes/renames go through the .bureau-ops manifest

    const userMsg = call.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("add a greeting module");
    expect(userMsg).toContain("the goal");
    expect(userMsg).toContain("exports hello()");
  });

  it("streams its output via onChunk when the caller wants live progress", async () => {
    const { provider } = fakeProvider("worked on it.\nAdded the module.");
    const cap = new EditCapability({ provider });
    const chunks: string[] = [];

    const out = await cap.execute(input({ onChunk: (c) => chunks.push(c) }));

    expect(chunks).toEqual(["worked on it.\nAdded the module."]); // the live stream was delivered
    expect(out.summary).toBe("Added the module."); // and the final summary still parsed
  });
});

describe("applyFileOps (Bureau-side delete/rename — no shell, no injection surface)", () => {
  it("applies delete + rename from the manifest, REJECTS traversal, and removes the manifest", async () => {
    const wt = await mkdtemp(join(tmpdir(), "bureau-edit-test-"));
    await writeFile(join(wt, "DELETE_ME.md"), "x");
    await writeFile(join(wt, "old.txt"), "y");
    // includes a path-traversal op that MUST be ignored, never escaping the worktree.
    await writeFile(join(wt, OPS_FILE), "delete DELETE_ME.md\nrename old.txt -> sub/new.txt\ndelete ../../../etc/passwd\n# a comment\n");

    const applied = await applyFileOps(wt);

    await expect(access(join(wt, "DELETE_ME.md"))).rejects.toThrow(); // deleted
    await expect(access(join(wt, "old.txt"))).rejects.toThrow(); // moved away
    expect(await readFileFs(join(wt, "sub", "new.txt"), "utf8")).toBe("y"); // renamed into a new subdir
    await expect(access(join(wt, OPS_FILE))).rejects.toThrow(); // manifest removed (never in the diff)
    expect(applied.some((a) => a.includes("deleted DELETE_ME.md"))).toBe(true);
    expect(applied.some((a) => a.includes("renamed old.txt"))).toBe(true);
    expect(applied.some((a) => a.toLowerCase().includes("passwd"))).toBe(false); // traversal never applied
  });

  it("is a safe no-op when the worker wrote no manifest", async () => {
    const wt = await mkdtemp(join(tmpdir(), "bureau-edit-test-"));
    expect(await applyFileOps(wt)).toEqual([]);
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
