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
  over: Partial<
    Record<
      | "chat"
      | "createTask"
      | "startTask"
      | "stopTask"
      | "confirmMerge"
      | "decideGate"
      | "listProjects"
      | "hub"
      | "gitInfo"
      | "listNotes"
      | "getNote"
      | "saveNote"
      | "usageSummary"
      | "listNotifications"
      | "unreadNotifications"
      | "markNotificationRead"
      | "markAllNotificationsRead",
      (...a: never[]) => unknown
    >
  > = {}
) {
  return {
    listProjects: over.listProjects ?? (() => [{ id: "widget", owner: "acme", name: "widget", baseBranch: "main" }]),
    chat: over.chat ?? (async () => ({ reply: irisMsg, proposal: PROPOSAL })),
    createTask: over.createTask ?? (() => makeTask()),
    startTask: over.startTask ?? (async () => makeTask()),
    stopTask: over.stopTask ?? (async () => makeTask()),
    confirmMerge: over.confirmMerge ?? (async () => makeTask()),
    decideGate: over.decideGate ?? (async () => makeTask()),
    hub: over.hub ?? (() => ({ workers: [], activity: [], awaitingReview: [], stats: { activeTasks: 0, awaitingReview: 0, merged: 0 } })),
    gitInfo:
      over.gitInfo ??
      (async () => ({ projectId: "widget", owner: "acme", name: "widget", baseBranch: "main", branch: "main", cloned: true, commits: [], branches: ["main"] })),
    usageSummary:
      over.usageSummary ?? (() => ({ totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, events: 0 }, byScope: [], byModel: [], byDay: [], sinceDay: null })),
    listNotifications: over.listNotifications ?? (() => []),
    unreadNotifications: over.unreadNotifications ?? (() => 0),
    markNotificationRead: over.markNotificationRead ?? (() => {}),
    markAllNotificationsRead: over.markAllNotificationsRead ?? (() => {}),
    listNotes: over.listNotes ?? (async () => []),
    getNote: over.getNote ?? (async () => null),
    saveNote:
      over.saveNote ?? (async (title: string, body: string) => ({ path: `notes/${title}.md`, title, kind: "note", updatedAt: "t", excerpt: "", body })),
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

describe("GET /api/projects", () => {
  it("lists the configured projects", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/projects`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string }[];
    expect(body[0]!.name).toBe("widget");
  });
});

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

  it("POST /api/tasks/:id/gate validates the body and routes to decideGate", async () => {
    const seen: { decision: string; notes?: string }[] = [];
    const orchestrator = fakeOrchestrator({
      decideGate: (async (_id: string, decision: string, notes?: string) => {
        seen.push({ decision, notes });
        return makeTask();
      }) as never,
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });

    expect((await post(`${url}/api/tasks/t1/gate`, { decision: "request_changes", notes: "fix it" })).status).toBe(200);
    expect(seen).toEqual([{ decision: "request_changes", notes: "fix it" }]);
    // a bad decision enum is rejected by the DTO → 400
    expect((await post(`${url}/api/tasks/t1/gate`, { decision: "maybe" })).status).toBe(400);
  });
});

describe("GET /api/hub", () => {
  it("returns the hub bundle", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/hub`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workers: unknown[]; stats: { merged: number } };
    expect(Array.isArray(body.workers)).toBe(true);
    expect(body.stats.merged).toBe(0);
  });
});

describe("GET /api/git", () => {
  it("returns the read-only repo view and passes projectId through", async () => {
    const seen: (string | undefined)[] = [];
    const orchestrator = fakeOrchestrator({
      gitInfo: (async (projectId?: string) => {
        seen.push(projectId);
        return { projectId: "p1", owner: "acme", name: "widget", baseBranch: "main", branch: "main", cloned: true, commits: [{ hash: "abc", author: "B", date: "d", subject: "init" }], branches: ["main"] };
      }) as never,
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/git?projectId=p1`);
    expect(res.status).toBe(200);
    expect((await res.json()).commits[0].subject).toBe("init");
    expect(seen).toEqual(["p1"]);
  });
});

describe("GET /api/usage", () => {
  it("returns the usage summary and passes ?days through", async () => {
    const seen: (number | undefined)[] = [];
    const orchestrator = fakeOrchestrator({
      usageSummary: ((days?: number) => {
        seen.push(days);
        return { totals: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, events: 1 }, byScope: [], byModel: [], byDay: [], sinceDay: null };
      }) as never,
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/usage?days=7`);
    expect(res.status).toBe(200);
    expect((await res.json()).totals.events).toBe(1);
    expect(seen).toEqual([7]);
  });
});

describe("notifications", () => {
  it("GET /api/notifications returns items + unread count", async () => {
    const orchestrator = fakeOrchestrator({
      listNotifications: (() => [{ id: "n1", kind: "review", taskId: "t1", subject: "Ready", body: "b", createdAt: "t", readAt: null }]) as never,
      unreadNotifications: (() => 1) as never,
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/notifications`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[]; unread: number };
    expect(body.items[0]!.id).toBe("n1");
    expect(body.unread).toBe(1);
  });

  it("POST /api/notifications/:id/read acknowledges one → 204", async () => {
    const read: string[] = [];
    const orchestrator = fakeOrchestrator({ markNotificationRead: ((id: string) => read.push(id)) as never });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    expect((await post(`${url}/api/notifications/n1/read`, {})).status).toBe(204);
    expect(read).toEqual(["n1"]);
  });

  it("POST /api/notifications/read-all → 204", async () => {
    let all = false;
    const orchestrator = fakeOrchestrator({ markAllNotificationsRead: (() => void (all = true)) as never });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    expect((await post(`${url}/api/notifications/read-all`, {})).status).toBe(204);
    expect(all).toBe(true);
  });
});

describe("System Memory", () => {
  it("GET /api/memory lists notes (passes ?q through)", async () => {
    const seen: (string | undefined)[] = [];
    const orchestrator = fakeOrchestrator({
      listNotes: (async (q?: string) => {
        seen.push(q);
        return [{ path: "notes/x.md", title: "X", kind: "note", updatedAt: "t", excerpt: "e" }];
      }) as never,
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/memory?q=hello`);
    expect(res.status).toBe(200);
    expect((await res.json())[0].title).toBe("X");
    expect(seen).toEqual(["hello"]);
  });

  it("POST /api/memory creates a note → 201", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    const res = await post(`${url}/api/memory`, { title: "Standards", body: "Use tabs" });
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("Standards");
  });

  it("POST /api/memory rejects an empty title → 400", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    expect((await post(`${url}/api/memory`, { title: "", body: "x" })).status).toBe(400);
  });

  it("GET /api/memory/:path returns 404 for a missing note", async () => {
    const url = await listen({ orchestrator: fakeOrchestrator(), store: fakeStore(), messages: fakeMessages() });
    expect((await fetch(`${url}/api/memory/notes/none.md`)).status).toBe(404);
  });

  it("GET /api/memory/:path returns a note when it exists", async () => {
    const orchestrator = fakeOrchestrator({
      getNote: (async (p: string) => ({ path: p, title: "Found", kind: "note", updatedAt: "t", excerpt: "e", body: "# Found" })) as never,
    });
    const url = await listen({ orchestrator, store: fakeStore(), messages: fakeMessages() });
    const res = await fetch(`${url}/api/memory/notes/found.md`);
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Found");
  });
});
