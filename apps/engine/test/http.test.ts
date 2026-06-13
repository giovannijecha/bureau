import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Task, TaskId, GateId } from "@bureau/core";
import type { Message } from "@bureau/contracts";

import { createHttpServer, type HttpDeps } from "../src/http.js";
import { OrchestratorError, type Orchestrator } from "../src/orchestrator.js";
import type { TaskStore, MessageLog } from "../src/ports.js";

// ── fixtures ──────────────────────────────────────────────────────────────

function makeTask(id = "t1"): Task {
  return {
    id: id as TaskId,
    goal: "do the thing",
    repoOwner: "acme",
    repoName: "widget",
    status: "awaiting_human",
    steps: [],
    gates: [{ id: "g1" as GateId, kind: "pr_approval", status: "open" }],
    artifacts: [],
    decisionLog: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const irisMsg: Message = { id: "m1", role: "iris", content: "hi", createdAt: "t" };

function fakeStore(seed: Task[] = []): TaskStore {
  const map = new Map<string, Task>(seed.map((t) => [t.id, t]));
  return { save: (t) => void map.set(t.id, t), load: (id) => map.get(id) ?? null, list: () => [...map.values()] };
}

function fakeMessages(): MessageLog {
  const items: Message[] = [];
  return { append: (m) => void items.push(m), list: () => items };
}

function fakeOrchestrator(over: Partial<Record<"handleMessage" | "decideGate" | "retryPr", (...a: never[]) => unknown>> = {}) {
  return {
    handleMessage: over.handleMessage ?? (async () => ({ message: irisMsg, task: makeTask() })),
    decideGate: over.decideGate ?? (async () => makeTask()),
    retryPr: over.retryPr ?? (async () => makeTask()),
  } as unknown as Orchestrator;
}

// ── server harness ────────────────────────────────────────────────────────

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(deps: HttpDeps): Promise<string> {
  server = createHttpServer(deps);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://localhost:${port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ── tests ─────────────────────────────────────────────────────────────────

describe("POST /api/messages", () => {
  it("returns 201 with the iris message and task detail on a valid body", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/messages`, { content: "add a /health endpoint" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: Message; task: { id: string; diff: string | null } };
    expect(body.message.role).toBe("iris");
    expect(body.task.id).toBe("t1");
  });

  it("returns 400 (not 500) on an empty content", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/messages`, { content: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid request body");
  });

  it("returns 400 on malformed JSON", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/messages`, "not json at all");
    expect(res.status).toBe(400);
  });

  it("sanitizes unexpected errors to a generic 500 (no internal leak)", async () => {
    const orchestrator = fakeOrchestrator({
      handleMessage: async () => {
        throw new Error("secret subprocess stderr with a token");
      },
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/messages`, { content: "x" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("internal error");
    expect(body.error).not.toMatch(/token/);
  });
});

describe("GET /api/tasks", () => {
  it("lists summaries", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore([makeTask("a"), makeTask("b")]), messages: fakeMessages() });
    const res = await fetch(`${url}/api/tasks`);
    expect(res.status).toBe(200);
    expect((await res.json()).map((t: { id: string }) => t.id)).toEqual(["a", "b"]);
  });

  it("returns 404 for a missing task", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    expect((await fetch(`${url}/api/tasks/missing`)).status).toBe(404);
  });

  it("returns the diff for a task", async () => {
    const task = { ...makeTask("d"), artifacts: [{ id: "ar1" as never, kind: "diff" as const, ref: "THE DIFF", producedByStep: "s1" as never, createdAt: "t" }] };
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore([task]), messages: fakeMessages() });
    const res = await fetch(`${url}/api/tasks/d/diff`);
    expect((await res.json()).diff).toBe("THE DIFF");
  });
});

describe("POST /api/gates/:id/decide", () => {
  it("maps an OrchestratorError to its status (409 conflict)", async () => {
    const orchestrator = fakeOrchestrator({
      decideGate: async () => {
        throw new OrchestratorError("gate already decided", 409);
      },
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/gates/g1/decide`, { decision: "approved" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already decided/);
  });

  it("returns 400 for an invalid decision enum", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/gates/g1/decide`, { decision: "maybe" });
    expect(res.status).toBe(400);
  });
});

describe("CORS", () => {
  it("answers preflight with 204 and permissive headers", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/messages`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
