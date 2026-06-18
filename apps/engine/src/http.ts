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
//   POST /api/tasks/:id/resume    re-run an interrupted task clean from base (no push)
//   POST /api/tasks/:id/discard   abort + tear down an interrupted task's worktree
//   POST /api/tasks/:id/merge     the final confirm: push → PR → squash-merge
//   POST /api/tasks/:id/open-pr   push → open a PR for review on GitHub, NO merge

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { SendMessageRequestDto, CreateTaskRequestDto, SaveNoteRequestDto, GateDecisionRequestDto, GitOpRequestDto, SetModelsRequestDto, CreateProjectRequestDto, EstimateRequestDto, SetBudgetRequestDto } from "@bureau/contracts";
import type { TaskId } from "@bureau/core";
import { VcsError } from "@bureau/vcs";
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
  // A rejected ref/path (assertSafeRef / sanitizeTreePath) is bad client input, not a
  // server fault — surface it as a typed 400 across the whole read-only browser surface
  // instead of a misleading 500. The security wall already blocked it before any argv.
  if (err instanceof VcsError) {
    sendJson(res, 400, { error: err.message });
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

  // POST /api/projects — add a repo by URL (validate → persist → clone → register).
  if (method === "POST" && path === "/api/projects") {
    const body = CreateProjectRequestDto.parse(await readJson(req));
    sendJson(res, 201, await deps.orchestrator.addProject(body));
    return;
  }

  // DELETE /api/projects/:id[?force=1] — remove a repo (refused while tasks reference it).
  const projDelMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (method === "DELETE" && projDelMatch) {
    await deps.orchestrator.removeProject(decodeURIComponent(projDelMatch[1]!), { force: url.searchParams.get("force") === "1" });
    res.writeHead(204).end();
    return;
  }

  // GET /api/config — engine status for Settings.
  if (method === "GET" && path === "/api/config") {
    sendJson(res, 200, deps.orchestrator.engineInfo());
    return;
  }

  // POST /api/config/models — set the per-scope model policy (validated; 422 on unknown).
  if (method === "POST" && path === "/api/config/models") {
    const body = SetModelsRequestDto.parse(await readJson(req));
    sendJson(res, 200, { models: deps.orchestrator.setModels(body.models) });
    return;
  }

  // POST /api/estimate — forecast a proposed pipeline's token + USD cost before creating it.
  if (method === "POST" && path === "/api/estimate") {
    const body = EstimateRequestDto.parse(await readJson(req));
    sendJson(res, 200, deps.orchestrator.estimateCost(body.capabilities));
    return;
  }

  // POST /api/config/budget — set the per-task USD spend cap (0 = no cap).
  if (method === "POST" && path === "/api/config/budget") {
    const body = SetBudgetRequestDto.parse(await readJson(req));
    sendJson(res, 200, { budgetUsd: deps.orchestrator.setBudget(body.budgetUsd) });
    return;
  }

  // GET /api/hub — the Agent-Activity Hub (worker status + activity + review queue).
  if (method === "GET" && path === "/api/hub") {
    sendJson(res, 200, deps.orchestrator.hub());
    return;
  }

  // GET /api/git[?projectId=] — read-only Git console for the active project.
  if (method === "GET" && path === "/api/git") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    sendJson(res, 200, await deps.orchestrator.gitInfo(projectId));
    return;
  }

  // GET /api/git/tree?projectId=&ref=&path= — one directory level of the codebase (read-only).
  if (method === "GET" && path === "/api/git/tree") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const ref = url.searchParams.get("ref") ?? undefined;
    const dir = url.searchParams.get("path") ?? "";
    sendJson(res, 200, await deps.orchestrator.gitTree(projectId, ref, dir));
    return;
  }

  // GET /api/git/show?projectId=&ref=&path= — a file's content at a ref (read-only).
  if (method === "GET" && path === "/api/git/show") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const ref = url.searchParams.get("ref") ?? undefined;
    const filePath = url.searchParams.get("path") ?? "";
    sendJson(res, 200, await deps.orchestrator.gitShow(projectId, ref, filePath));
    return;
  }

  // GET /api/github-account — the connected GitHub account (read-only, via gh CLI).
  if (method === "GET" && path === "/api/github-account") {
    sendJson(res, 200, await deps.orchestrator.githubAccount());
    return;
  }

  // GET /api/git/prs?projectId= — the repo's pull requests (read-only, via gh).
  if (method === "GET" && path === "/api/git/prs") {
    sendJson(res, 200, await deps.orchestrator.prList(url.searchParams.get("projectId") ?? undefined));
    return;
  }

  // GET /api/git/issues?projectId= — the repo's issues (read-only, via gh).
  if (method === "GET" && path === "/api/git/issues") {
    sendJson(res, 200, await deps.orchestrator.issueList(url.searchParams.get("projectId") ?? undefined));
    return;
  }

  // GET /api/git/tree-commits?projectId=&ref=&path= — latest commit per entry (read-only).
  if (method === "GET" && path === "/api/git/tree-commits") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const ref = url.searchParams.get("ref") ?? undefined;
    const dir = url.searchParams.get("path") ?? "";
    sendJson(res, 200, await deps.orchestrator.gitTreeCommits(projectId, ref, dir));
    return;
  }

  // GET /api/git/commit?projectId=&ref= — one commit's detail + patch (read-only).
  if (method === "GET" && path === "/api/git/commit") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const ref = url.searchParams.get("ref") ?? undefined;
    sendJson(res, 200, await deps.orchestrator.gitCommit(projectId, ref));
    return;
  }

  // GET /api/git/files?projectId=&ref= — all file paths for the "go to file" finder.
  if (method === "GET" && path === "/api/git/files") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const ref = url.searchParams.get("ref") ?? undefined;
    sendJson(res, 200, await deps.orchestrator.gitFiles(projectId, ref));
    return;
  }

  // GET /api/git/file-history?projectId=&ref=&path= — commits that touched a file.
  if (method === "GET" && path === "/api/git/file-history") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const ref = url.searchParams.get("ref") ?? undefined;
    const filePath = url.searchParams.get("path") ?? "";
    sendJson(res, 200, await deps.orchestrator.gitFileHistory(projectId, ref, filePath));
    return;
  }

  // POST /api/git/cleanup[?projectId=] — delete leftover bureau/task-* branches.
  if (method === "POST" && path === "/api/git/cleanup") {
    const projectId = url.searchParams.get("projectId") ?? undefined;
    sendJson(res, 200, await deps.orchestrator.cleanupTaskBranches(projectId));
    return;
  }

  // POST /api/git/op — run a CEO-authorized git operation (destructive ops need confirmation).
  if (method === "POST" && path === "/api/git/op") {
    const body = GitOpRequestDto.parse(await readJson(req));
    sendJson(res, 200, await deps.orchestrator.runGitOp(body));
    return;
  }

  // DELETE /api/git/branch?name=<branch>[&projectId=] — delete ONE bureau/task-* branch.
  if (method === "DELETE" && path === "/api/git/branch") {
    const name = url.searchParams.get("name");
    const projectId = url.searchParams.get("projectId") ?? undefined;
    if (!name) {
      sendJson(res, 400, { error: "missing branch name" });
      return;
    }
    sendJson(res, 200, await deps.orchestrator.deleteBranch(name, projectId));
    return;
  }

  // GET /api/usage — token spend + cost. ?days=N limits the window (default all-time).
  if (method === "GET" && path === "/api/usage") {
    const daysRaw = url.searchParams.get("days");
    const days = daysRaw !== null && /^\d+$/.test(daysRaw) ? Number(daysRaw) : undefined;
    sendJson(res, 200, deps.orchestrator.usageSummary(days));
    return;
  }

  // GET /api/notifications — the CEO's inbox (newest first) + unread count.
  if (method === "GET" && path === "/api/notifications") {
    sendJson(res, 200, { items: deps.orchestrator.listNotifications(), unread: deps.orchestrator.unreadNotifications() });
    return;
  }

  // POST /api/notifications/read-all — acknowledge everything.
  if (method === "POST" && path === "/api/notifications/read-all") {
    deps.orchestrator.markAllNotificationsRead();
    res.writeHead(204).end();
    return;
  }

  // POST /api/notifications/:id/read — acknowledge one.
  const notifMatch = /^\/api\/notifications\/([^/]+)\/read$/.exec(path);
  if (method === "POST" && notifMatch) {
    deps.orchestrator.markNotificationRead(decodeURIComponent(notifMatch[1]!));
    res.writeHead(204).end();
    return;
  }

  // GET /api/memory — vault notes (optionally ?q= filtered).  POST creates a note.
  if (path === "/api/memory") {
    if (method === "GET") {
      const q = url.searchParams.get("q") ?? undefined;
      sendJson(res, 200, await deps.orchestrator.listNotes(q));
      return;
    }
    if (method === "POST") {
      const body = SaveNoteRequestDto.parse(await readJson(req));
      sendJson(res, 201, await deps.orchestrator.saveNote(body.title, body.body, body.expectedPath));
      return;
    }
  }

  // GET /api/memory/:path — one note (path may contain slashes, e.g. notes/foo.md).
  // DELETE /api/memory/:path — remove a note.
  if (path.startsWith("/api/memory/")) {
    const notePath = decodeURIComponent(path.slice("/api/memory/".length));
    if (method === "GET") {
      const note = await deps.orchestrator.getNote(notePath);
      if (!note) {
        sendJson(res, 404, { error: "note not found" });
        return;
      }
      sendJson(res, 200, note);
      return;
    }
    if (method === "DELETE") {
      await deps.orchestrator.deleteNote(notePath);
      res.writeHead(204).end();
      return;
    }
  }

  // POST /api/chat — a conversation turn with Iris, scoped to a project + thread.
  if (method === "POST" && path === "/api/chat") {
    const body = SendMessageRequestDto.parse(await readJson(req));
    const result = body.ephemeral
      ? await deps.orchestrator.chatEphemeral(body.content, body.projectId, body.history ?? [], body.attachments)
      : await deps.orchestrator.chat(body.content, body.projectId, body.conversationId, body.attachments);
    sendJson(res, 200, result);
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

  // DELETE /api/tasks/:id — stop (if live) and permanently remove the task.
  const deleteMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (method === "DELETE" && deleteMatch) {
    await deps.orchestrator.deleteTask(decodeURIComponent(deleteMatch[1]!));
    res.writeHead(204).end();
    return;
  }

  // POST /api/tasks/:id/(start|stop|resume|discard|merge|open-pr|merge-pr)
  const actionMatch = /^\/api\/tasks\/([^/]+)\/(start|stop|resume|discard|merge|open-pr|merge-pr)$/.exec(path);
  if (method === "POST" && actionMatch) {
    const id = decodeURIComponent(actionMatch[1]!);
    const action = actionMatch[2];
    const task =
      action === "start"
        ? await deps.orchestrator.startTask(id)
        : action === "stop"
          ? await deps.orchestrator.stopTask(id)
          : action === "resume"
            ? await deps.orchestrator.resumeTask(id)
            : action === "discard"
              ? await deps.orchestrator.discardTask(id)
              : action === "open-pr"
                ? await deps.orchestrator.openPrForReview(id)
                : action === "merge-pr"
                  ? await deps.orchestrator.mergeOpenPr(id)
                  : await deps.orchestrator.confirmMerge(id);
    sendJson(res, 200, toTaskDetail(task));
    return;
  }

  // POST /api/tasks/:id/gate — the CEO's review decision: approve / request_changes / reject.
  const gateMatch = /^\/api\/tasks\/([^/]+)\/gate$/.exec(path);
  if (method === "POST" && gateMatch) {
    const id = decodeURIComponent(gateMatch[1]!);
    const body = GateDecisionRequestDto.parse(await readJson(req));
    const task = await deps.orchestrator.decideGate(id, body.decision, body.notes);
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
