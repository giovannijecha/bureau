// HTTP API for the panel. Plain node:http (no framework) — localhost only.
// Routes:
//   GET  /health                  liveness
//   GET  /api/projects            the repositories Bureau works on
//   POST /api/chat                converse with Iris → { reply, proposal? }
//   GET  /api/messages            the chat log
//   GET  /api/tasks               TaskSummary[]
//   POST /api/tasks               create a draft task from a proposal → TaskDetail
//   GET  /api/tasks/:id           TaskDetail
//   GET  /api/tasks/:id/diff      { diff }
//   POST /api/tasks/:id/start     run the pipeline (local commit, no push)
//   POST /api/tasks/:id/stop      abort + clean up
//   POST /api/tasks/:id/merge     the final confirm: push → PR → squash-merge

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { SendMessageRequestDto, CreateTaskRequestDto } from "@bureau/contracts";
import type { TaskId } from "@bureau/core";
import { Orchestrator, OrchestratorError } from "./orchestrator.js";
import type { TaskStore, MessageLog } from "./ports.js";
import { toTaskSummary, toTaskDetail, latestDiff } from "./summary.js";

export interface HttpDeps {
  readonly orchestrator: Orchestrator;
  readonly store: TaskStore;
  readonly messages: MessageLog;
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    handle(deps, req, res).catch((err: unknown) => respondError(res, err));
  });
}

function respondError(res: ServerResponse, err: unknown): void {
  if (err instanceof SyntaxError || isZodError(err)) {
    sendJson(res, 400, { error: "invalid request body" });
    return;
  }
  if (err instanceof OrchestratorError) {
    sendJson(res, err.status, { error: err.message });
    return;
  }
  console.error("[engine] unhandled error:", err);
  sendJson(res, 500, { error: "internal error" });
}

function isZodError(err: unknown): boolean {
  return err instanceof Error && err.name === "ZodError";
}

async function handle(deps: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // GET /api/projects — the repositories Bureau works on.
  if (method === "GET" && path === "/api/projects") {
    sendJson(res, 200, deps.orchestrator.listProjects());
    return;
  }

  // POST /api/chat — a conversation turn with Iris, scoped to a project + thread.
  if (method === "POST" && path === "/api/chat") {
    const body = SendMessageRequestDto.parse(await readJson(req));
    sendJson(res, 200, await deps.orchestrator.chat(body.content, body.projectId, body.conversationId));
    return;
  }

  // GET /api/conversations — the CEO's chat threads, most-recent first.
  if (method === "GET" && path === "/api/conversations") {
    sendJson(res, 200, deps.orchestrator.listConversations());
    return;
  }

  // POST /api/conversations — start a new, empty thread.
  if (method === "POST" && path === "/api/conversations") {
    const body = (await readJson(req)) as { projectId?: unknown };
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
    sendJson(res, 201, deps.orchestrator.createConversation(projectId));
    return;
  }

  // GET /api/conversations/:id/messages  and  DELETE /api/conversations/:id
  const convMatch = /^\/api\/conversations\/([^/]+?)(\/messages)?$/.exec(path);
  if (convMatch) {
    const id = decodeURIComponent(convMatch[1]!);
    if (method === "GET" && convMatch[2]) {
      sendJson(res, 200, deps.orchestrator.messagesFor(id));
      return;
    }
    if (method === "DELETE" && !convMatch[2]) {
      deps.orchestrator.deleteConversation(id);
      res.writeHead(204).end();
      return;
    }
  }

  // GET /api/messages — the full chat log (all threads).
  if (method === "GET" && path === "/api/messages") {
    sendJson(res, 200, deps.messages.list());
    return;
  }

  // GET /api/tasks
  if (method === "GET" && path === "/api/tasks") {
    sendJson(res, 200, deps.store.list().map(toTaskSummary));
    return;
  }

  // POST /api/tasks — create a draft task from a proposal, in a project.
  if (method === "POST" && path === "/api/tasks") {
    const body = CreateTaskRequestDto.parse(await readJson(req));
    sendJson(res, 201, toTaskDetail(deps.orchestrator.createTask(body.proposal, body.projectId)));
    return;
  }

  // GET /api/tasks/:id  and  GET /api/tasks/:id/diff
  const taskMatch = /^\/api\/tasks\/([^/]+)(\/diff)?$/.exec(path);
  if (method === "GET" && taskMatch) {
    const task = deps.store.load(decodeURIComponent(taskMatch[1]!) as TaskId);
    if (!task) {
      sendJson(res, 404, { error: "task not found" });
      return;
    }
    sendJson(res, 200, taskMatch[2] ? { diff: latestDiff(task) } : toTaskDetail(task));
    return;
  }

  // POST /api/tasks/:id/(start|stop|merge)
  const actionMatch = /^\/api\/tasks\/([^/]+)\/(start|stop|merge)$/.exec(path);
  if (method === "POST" && actionMatch) {
    const id = decodeURIComponent(actionMatch[1]!);
    const action = actionMatch[2];
    const task =
      action === "start"
        ? await deps.orchestrator.startTask(id)
        : action === "stop"
          ? await deps.orchestrator.stopTask(id)
          : await deps.orchestrator.confirmMerge(id);
    sendJson(res, 200, toTaskDetail(task));
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

// ── helpers ───────────────────────────────────────────────────────────────

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw.length ? JSON.parse(raw) : {};
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*"); // localhost-only daemon
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
