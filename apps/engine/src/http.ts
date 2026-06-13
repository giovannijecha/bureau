// HTTP API for the panel. Plain node:http (no framework) — localhost only.
// Routes:
//   POST /api/messages            chat → Iris; returns { message, task: TaskDetail }
//   GET  /api/messages            the chat log
//   GET  /api/tasks               TaskSummary[]
//   GET  /api/tasks/:id           TaskDetail
//   GET  /api/tasks/:id/diff      { diff }
//   POST /api/gates/:id/decide    human gate decision → TaskDetail

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { SendMessageRequestDto, GateDecisionRequestDto } from "@bureau/contracts";
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

/** Map errors to clean statuses; never leak parser/subprocess internals on 500. */
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

  // POST /api/messages
  if (method === "POST" && path === "/api/messages") {
    const body = SendMessageRequestDto.parse(await readJson(req));
    const { message, task } = await deps.orchestrator.handleMessage(body.content);
    sendJson(res, 201, { message, task: toTaskDetail(task) });
    return;
  }

  // GET /api/messages
  if (method === "GET" && path === "/api/messages") {
    sendJson(res, 200, deps.messages.list());
    return;
  }

  // GET /api/tasks
  if (method === "GET" && path === "/api/tasks") {
    sendJson(res, 200, deps.store.list().map(toTaskSummary));
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

  // POST /api/tasks/:id/retry-pr  (recover a pushed-but-PR-failed task)
  const retryMatch = /^\/api\/tasks\/([^/]+)\/retry-pr$/.exec(path);
  if (method === "POST" && retryMatch) {
    const task = await deps.orchestrator.retryPr(decodeURIComponent(retryMatch[1]!));
    sendJson(res, 200, toTaskDetail(task));
    return;
  }

  // POST /api/gates/:id/decide
  const gateMatch = /^\/api\/gates\/([^/]+)\/decide$/.exec(path);
  if (method === "POST" && gateMatch) {
    const body = GateDecisionRequestDto.parse(await readJson(req));
    const task = await deps.orchestrator.decideGate(
      decodeURIComponent(gateMatch[1]!),
      body.decision,
      body.notes
    );
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
