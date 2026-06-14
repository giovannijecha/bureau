import { describe, it, expect } from "vitest";

import type { Provider } from "@bureau/providers";
import type { Message } from "@bureau/contracts";

import { parseIris, irisRespond } from "../src/iris.js";

const PROJECT = { owner: "acme", name: "widget", baseBranch: "main", hasTests: false };

const PROPOSAL_JSON = JSON.stringify({
  reply: "Sure!",
  proposal: { title: "T", summary: "S", steps: [{ capability: "edit", description: "d" }] },
});

/** A provider that returns a queued response per send() call (last one repeats). */
function queueProvider(...responses: string[]) {
  let i = 0;
  let sends = 0;
  const next = () => {
    const content = responses[Math.min(i, responses.length - 1)] ?? "";
    i++;
    return { content, inputTokens: 0, outputTokens: 0 };
  };
  const provider: Provider = {
    name: "fake",
    authStrategy: { kind: "api-key", isAvailable: () => true },
    async send() {
      sends++;
      return next();
    },
    async stream(_m, onChunk) {
      sends++;
      const r = next();
      onChunk(r.content);
      return r;
    },
  };
  return { provider, sendCount: () => sends };
}

const user = (content: string): Message[] => [{ id: "1", role: "user", content, createdAt: "" }];

describe("parseIris", () => {
  it("extracts reply + proposal from clean JSON", () => {
    const t = parseIris(PROPOSAL_JSON);
    expect(t.reply).toBe("Sure!");
    expect(t.proposal?.title).toBe("T");
  });

  it("returns reply only when the JSON has no proposal", () => {
    const t = parseIris(JSON.stringify({ reply: "just chatting" }));
    expect(t.reply).toBe("just chatting");
    expect(t.proposal).toBeUndefined();
  });

  it("falls back to prose when there is no JSON at all", () => {
    const t = parseIris("I think we should do X.");
    expect(t.reply).toBe("I think we should do X.");
    expect(t.proposal).toBeUndefined();
  });

  it("extracts the JSON object even with surrounding text / markdown fences", () => {
    const t = parseIris("Here you go:\n```json\n" + PROPOSAL_JSON + "\n```");
    expect(t.proposal?.title).toBe("T");
  });

  it("drops an invalid proposal shape but keeps the reply", () => {
    const t = parseIris(JSON.stringify({ reply: "hi", proposal: { title: "x" } }));
    expect(t.reply).toBe("hi");
    expect(t.proposal).toBeUndefined();
  });
});

describe("irisRespond", () => {
  it("calls the provider once when the first response is valid JSON", async () => {
    const { provider, sendCount } = queueProvider(PROPOSAL_JSON);
    const t = await irisRespond(provider, user("do x"), PROJECT);
    expect(t.proposal?.title).toBe("T");
    expect(sendCount()).toBe(1);
  });

  it("retries once when the model emits prose, recovering the proposal", async () => {
    const { provider, sendCount } = queueProvider("Let me think... I should propose an edit task.", PROPOSAL_JSON);
    const t = await irisRespond(provider, user("do x"), PROJECT);
    expect(t.proposal?.title).toBe("T"); // recovered on the retry
    expect(sendCount()).toBe(2);
  });

  it("falls back to a prose reply if both attempts lack JSON (never throws)", async () => {
    const { provider, sendCount } = queueProvider("no json here", "still no json");
    const t = await irisRespond(provider, user("hi"), PROJECT);
    expect(t.reply).toBe("no json here");
    expect(t.proposal).toBeUndefined();
    expect(sendCount()).toBe(2);
  });

  it("injects the repo git context into the system prompt so Iris knows the branches", async () => {
    let systemSeen = "";
    const provider: Provider = {
      name: "fake",
      authStrategy: { kind: "api-key", isAvailable: () => true },
      async send(messages) {
        systemSeen = messages.find((m) => m.role === "system")?.content ?? "";
        return { content: JSON.stringify({ reply: "ok" }), inputTokens: 0, outputTokens: 0 };
      },
      async stream() {
        return { content: "", inputTokens: 0, outputTokens: 0 };
      },
    };
    await irisRespond(provider, user("which branches exist?"), PROJECT, undefined, "Repository git state: Branches: main, feature-x");
    expect(systemSeen).toContain("Repository git state");
    expect(systemSeen).toContain("feature-x");
  });

  it("tells Iris whether the project has a configured test suite (gates test-step proposals)", async () => {
    let systemSeen = "";
    const provider: Provider = {
      name: "fake",
      authStrategy: { kind: "api-key", isAvailable: () => true },
      async send(messages) {
        systemSeen = messages.find((m) => m.role === "system")?.content ?? "";
        return { content: JSON.stringify({ reply: "ok" }), inputTokens: 0, outputTokens: 0 };
      },
      async stream() {
        return { content: "", inputTokens: 0, outputTokens: 0 };
      },
    };
    await irisRespond(provider, user("hi"), { ...PROJECT, hasTests: true });
    expect(systemSeen).toContain("HAS a configured test suite");
    systemSeen = "";
    await irisRespond(provider, user("hi"), { ...PROJECT, hasTests: false });
    expect(systemSeen).toMatch(/NO test command|do NOT propose a "test"/);
  });
});
