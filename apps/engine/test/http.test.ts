import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Task, TaskId, GateId, StepId } from "@bureau/core";
import type { Message, TaskProposal } from "@bureau/contracts";

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
    status: "created",
    steps: [
      {
        id: "s1" as StepId,
        capability: "edit",
        description: "edit a file",
        acceptanceCriteria: [],
        status: "pending",
        artifactIds: [],
        gateAfter: "g1" as GateId,
      },
    ],
    gates: [{ id: "g1" as GateId, kind: "pr_approval", status: "pending" }],
    artifacts: [],
    decisionLog: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const irisMsg: Message = { id: "m1", role: "iris", content: "hi", createdAt: "t" };
const PROPOSAL: TaskProposal = { title: "T", summary: "S", steps: [{ capability: "edit", description: "d" }] };

function fakeStore(seed: Task[] = []): TaskStore {
  const map = new Map<string, Task>(seed.map((t) => [t.id, t]));
  return { save: (t) => void map.set(t.id, t), load: (id) => map.get(id) ?? null, list: () => [...map.values()] };
}

function fakeMessages(): MessageLog {
  const items: Message[] = [];
  return { append: (m) => void items.push(m), list: () => items };
}

function fakeOrchestrator(
  over: Partial<Record<"chat" | "createTask" | "startTask" | "stopTask" | "confirmMerge", (...a: never[]) => unknown>> = {}
) {
  return {
    chat: over.chat ?? (async () => ({ reply: irisMsg, proposal: PROPOSAL })),
    createTask: over.createTask ?? (() => makeTask()),
    startTask: over.startTask ?? (async () => makeTask()),
    stopTask: over.stopTask ?? (async () => makeTask()),
    confirmMerge: over.confirmMerge ?? (async () => makeTask()),
  } as unknown as Orchestrator;
}

// ── server harness ────────────────────────────────────────────────────────

let server: Server | undefined;
afterEach(() => server?.close());

async function listen(deps: HttpDeps): Promise<string> {
  server = createHttpServer(deps);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  return `http://localhost:${(server!.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ── tests ─────────────────────────────────────────────────────────────────

describe("POST /api/chat", () => {
  it("returns Iris's reply + proposal", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/chat`, { content: "make a change" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply: Message; proposal: TaskProposal };
    expect(body.reply.role).toBe("iris");
    expect(body.proposal.title).toBe("T");
  });

  it("returns 400 on empty content", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/chat`, { content: "" });
    expect(res.status).toBe(400);
  });

  it("sanitizes unexpected errors to a generic 500", async () => {
    const orchestrator = fakeOrchestrator({
      chat: async () => {
        throw new Error("secret stderr");
      },
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/chat`, { content: "x" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("internal error");
  });
});

describe("POST /api/tasks (create)", () => {
  it("creates a draft task from a proposal → 201", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/tasks`, { proposal: PROPOSAL });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; steps: unknown[] };
    expect(body.id).toBe("t1");
    expect(body.steps).toHaveLength(1);
  });

  it("returns 400 for a malformed proposal", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    expect((await post(`${url}/api/tasks`, { proposal: { title: "x" } })).status).toBe(400);
  });
});

describe("task actions", () => {
  it("GET /api/tasks lists summaries", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore([makeTask("a"), makeTask("b")]), messages: fakeMessages() });
    const res = await fetch(`${url}/api/tasks`);
    expect((await res.json()).map((t: { id: string }) => t.id)).toEqual(["a", "b"]);
  });

  it("GET /api/tasks/:id 404 for missing", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    expect((await fetch(`${url}/api/tasks/missing`)).status).toBe(404);
  });

  it("POST /api/tasks/:id/start → 200 TaskDetail", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/tasks/t1/start`, {});
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("t1");
  });

  it("POST /api/tasks/:id/merge maps an OrchestratorError to its status (409)", async () => {
    const orchestrator = fakeOrchestrator({
      confirmMerge: async () => {
        throw new OrchestratorError("no open gate", 409);
      },
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/tasks/t1/merge`, {});
    expect(res.status).toBe(409);
  });
});
