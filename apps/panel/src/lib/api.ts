// Typed client for the Bureau engine API. The panel imports ONLY @bureau/contracts.

import type {
  TaskDetail,
  TaskSummary,
  ChatResponse,
  TaskProposal,
  Project,
  Message,
  Conversation,
  EngineInfo,
  Hub,
  NoteSummary,
  Note,
  UsageSummary,
  Notification,
  GitInfo,
  GitTree,
  GitFileContent,
  GithubAccount,
  PullRequest,
  Issue,
  TreeCommits,
  CommitDetail,
  FileList,
  FileHistory,
  Attachment,
  GitOpRequest,
  GitOpResult,
  CreateProjectRequest,
} from "@bureau/contracts";

export const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4319";
const BASE = ENGINE_URL;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `engine responded ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const postJson = (path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/** The repositories Bureau works on. */
export async function listProjects(): Promise<Project[]> {
  return json(await fetch(`${BASE}/api/projects`));
}

/** Add a repo by URL (engine validates, clones, and registers it). */
export async function createProject(req: CreateProjectRequest): Promise<Project> {
  return json(await postJson("/api/projects", req));
}

/** Remove a repo. `force` overrides the in-flight-task guard (rarely needed). */
export async function removeProject(id: string, force = false): Promise<void> {
  const res = await fetch(`${BASE}/api/projects/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `engine responded ${res.status}`);
  }
}

/** Engine status (provider availability + counts) for Settings. */
export async function getConfig(): Promise<EngineInfo> {
  return json(await fetch(`${BASE}/api/config`));
}

/** The connected GitHub account (read-only, via the gh CLI) for Settings. */
export async function getGithubAccount(): Promise<GithubAccount> {
  return json(await fetch(`${BASE}/api/github-account`));
}

/** Set the per-scope model policy (Settings). Returns the updated map. */
export async function setModels(models: Record<string, string>): Promise<{ models: Record<string, string> }> {
  return json(await postJson("/api/config/models", { models }));
}

/** The repo's pull requests (read-only, via gh). */
export async function getPrs(projectId?: string): Promise<PullRequest[]> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return json(await fetch(`${BASE}/api/git/prs${suffix}`));
}

/** The repo's issues (read-only, via gh). */
export async function getIssues(projectId?: string): Promise<Issue[]> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return json(await fetch(`${BASE}/api/git/issues${suffix}`));
}

/** The Agent-Activity Hub: worker status + cross-task activity + review queue. */
export async function getHub(): Promise<Hub> {
  return json(await fetch(`${BASE}/api/hub`));
}

/** Read-only Git console for a project (current branch, recent commits, branches). */
export async function getGitInfo(projectId?: string): Promise<GitInfo> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return json(await fetch(`${BASE}/api/git${suffix}`));
}

/** Read-only codebase browser: one directory level of the repo at `ref`. */
export async function getGitTree(projectId: string | undefined, ref: string | undefined, path: string): Promise<GitTree> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (ref) params.set("ref", ref);
  if (path) params.set("path", path);
  return json(await fetch(`${BASE}/api/git/tree?${params.toString()}`));
}

/** Read-only codebase browser: a file's content at `ref`. */
export async function getGitShow(projectId: string | undefined, ref: string | undefined, path: string): Promise<GitFileContent> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (ref) params.set("ref", ref);
  params.set("path", path);
  return json(await fetch(`${BASE}/api/git/show?${params.toString()}`));
}

/** Read-only: the latest commit that touched each entry of a directory at `ref`
 *  (the code browser's "latest commit" column — loaded after the tree). */
export async function getTreeCommits(projectId: string | undefined, ref: string | undefined, path: string): Promise<TreeCommits> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (ref) params.set("ref", ref);
  if (path) params.set("path", path);
  return json(await fetch(`${BASE}/api/git/tree-commits?${params.toString()}`));
}

/** Read-only: one commit's metadata, file stats, and patch (the diff viewer). */
export async function getCommit(projectId: string | undefined, ref: string): Promise<CommitDetail> {
  const params = new URLSearchParams({ ref });
  if (projectId) params.set("projectId", projectId);
  return json(await fetch(`${BASE}/api/git/commit?${params.toString()}`));
}

/** Read-only: every file path in the repo at `ref` (the "go to file" finder). */
export async function getFiles(projectId: string | undefined, ref: string | undefined): Promise<FileList> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (ref) params.set("ref", ref);
  return json(await fetch(`${BASE}/api/git/files?${params.toString()}`));
}

/** Read-only: commits that touched a file, newest first (file history). */
export async function getFileHistory(projectId: string | undefined, ref: string | undefined, path: string): Promise<FileHistory> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (ref) params.set("ref", ref);
  params.set("path", path);
  return json(await fetch(`${BASE}/api/git/file-history?${params.toString()}`));
}

/** Delete leftover bureau/task-* branches (keeps in-flight tasks). Returns the result. */
export async function cleanupBranches(projectId?: string): Promise<{ deleted: string[]; kept: number }> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return json(await postJson(`/api/git/cleanup${suffix}`));
}

/** Delete ONE bureau/task-* branch (local + origin). Refuses in-flight/non-task branches. */
export async function deleteBranch(branch: string, projectId?: string): Promise<{ deleted: boolean }> {
  const params = new URLSearchParams({ name: branch });
  if (projectId) params.set("projectId", projectId);
  return json(await fetch(`${BASE}/api/git/branch?${params.toString()}`, { method: "DELETE" }));
}

/** Run a CEO-AUTHORIZED git history/admin operation (squash, force-push, branch/tag admin).
 *  Destructive ops require `confirmation` to exactly match the target branch (server-enforced). */
export async function runGitOp(req: GitOpRequest): Promise<GitOpResult> {
  return json(await postJson("/api/git/op", req));
}

/** Usage & cost metrics. `days` limits the look-back window (omit for all-time). */
export async function getUsage(days?: number): Promise<UsageSummary> {
  const suffix = days && days > 0 ? `?days=${days}` : "";
  return json(await fetch(`${BASE}/api/usage${suffix}`));
}

/** The CEO's notification inbox + unread count. */
export async function listNotifications(): Promise<{ items: Notification[]; unread: number }> {
  return json(await fetch(`${BASE}/api/notifications`));
}

export async function markNotificationRead(id: string): Promise<void> {
  const res = await postJson(`/api/notifications/${encodeURIComponent(id)}/read`);
  if (!res.ok) throw new Error(`engine responded ${res.status}`);
}

export async function markAllNotificationsRead(): Promise<void> {
  const res = await postJson("/api/notifications/read-all");
  if (!res.ok) throw new Error(`engine responded ${res.status}`);
}

/** System Memory — the vault's notes (task journals + CEO/Iris notes). */
export async function listNotes(q?: string): Promise<NoteSummary[]> {
  const suffix = q && q.trim() !== "" ? `?q=${encodeURIComponent(q)}` : "";
  return json(await fetch(`${BASE}/api/memory${suffix}`));
}

export async function getNote(path: string): Promise<Note> {
  return json(await fetch(`${BASE}/api/memory/${path.split("/").map(encodeURIComponent).join("/")}`));
}

/** Create or update a free-form CEO/Iris note. `expectedPath` (the note being edited)
 *  lets the engine refuse to overwrite a different existing note. */
export async function saveNote(title: string, body: string, expectedPath?: string): Promise<Note> {
  return json(await postJson("/api/memory", { title, body, expectedPath }));
}

/** Delete a vault note by its path. */
export async function deleteNote(notePath: string): Promise<void> {
  const res = await fetch(`${BASE}/api/memory/${notePath.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`engine responded ${res.status}`);
}

/** The CEO's chat threads, most-recent first. */
export async function listConversations(): Promise<Conversation[]> {
  return json(await fetch(`${BASE}/api/conversations`));
}

/** Start a new, empty conversation. */
export async function createConversation(projectId?: string): Promise<Conversation> {
  return json(await postJson("/api/conversations", { projectId }));
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`engine responded ${res.status}`);
}

/** Messages in one conversation. */
export async function messagesFor(conversationId: string): Promise<Message[]> {
  return json(await fetch(`${BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`));
}

/** A conversation turn with Iris, scoped to the active project + thread. Optional
 *  attachments (images Iris views, text files inlined as context). */
export async function chat(
  content: string,
  projectId?: string,
  conversationId?: string,
  attachments?: Attachment[]
): Promise<ChatResponse> {
  return json(await postJson("/api/chat", { content, projectId, conversationId, attachments }));
}

/** A STATELESS turn with Iris (the terminal dock) — persists nothing server-side, so
 *  it never appears in the Assistant. Pass the prior turns inline so Iris keeps context. */
export async function chatEphemeral(
  content: string,
  projectId: string | undefined,
  history: { role: "user" | "iris"; content: string }[],
  attachments?: Attachment[]
): Promise<ChatResponse> {
  return json(await postJson("/api/chat", { content, projectId, ephemeral: true, history, attachments }));
}

/** Materialize a proposal into a draft task in the active project. */
export async function createTask(proposal: TaskProposal, projectId?: string): Promise<TaskDetail> {
  return json(await postJson("/api/tasks", { proposal, projectId }));
}

export async function listTasks(): Promise<TaskSummary[]> {
  return json(await fetch(`${BASE}/api/tasks`));
}

export async function getTask(id: string): Promise<TaskDetail> {
  return json(await fetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`));
}

export async function startTask(id: string): Promise<TaskDetail> {
  return json(await postJson(`/api/tasks/${encodeURIComponent(id)}/start`));
}
export async function stopTask(id: string): Promise<TaskDetail> {
  return json(await postJson(`/api/tasks/${encodeURIComponent(id)}/stop`));
}
export async function mergeTask(id: string): Promise<TaskDetail> {
  return json(await postJson(`/api/tasks/${encodeURIComponent(id)}/merge`));
}
/** Push the branch + open a PR for review on GitHub WITHOUT merging — the branch
 *  lives on GitHub for the CEO to test and merge there. Same gate as a merge. */
export async function openPrForReview(id: string): Promise<TaskDetail> {
  return json(await postJson(`/api/tasks/${encodeURIComponent(id)}/open-pr`));
}
/** Merge the open PR of a task earlier "Open PR (no merge)"'d — the deferred squash-merge. */
export async function mergeOpenPr(id: string): Promise<TaskDetail> {
  return json(await postJson(`/api/tasks/${encodeURIComponent(id)}/merge-pr`));
}

/** Permanently delete a task (stops it first if it's still live). */
export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`engine responded ${res.status}`);
}

/** The CEO's review decision at the open gate: approve (merge), request changes
 *  (re-run with notes), or reject (abort). */
export async function decideGate(
  id: string,
  decision: "approved" | "rejected" | "request_changes",
  notes?: string
): Promise<TaskDetail> {
  return json(await postJson(`/api/tasks/${encodeURIComponent(id)}/gate`, { decision, notes }));
}

/** Lightweight reachability check for a connection indicator. */
export async function ping(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/health`)).ok;
  } catch {
    return false;
  }
}
