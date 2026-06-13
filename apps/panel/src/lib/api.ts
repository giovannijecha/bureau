// Typed client for the Bureau engine API. The panel imports ONLY @bureau/contracts.

import type { TaskDetail, TaskSummary, ChatResponse, TaskProposal, Project, Message } from "@bureau/contracts";

const BASE = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4319";

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

/** The persisted chat log (survives restarts). */
export async function listMessages(): Promise<Message[]> {
  return json(await fetch(`${BASE}/api/messages`));
}

/** A conversation turn with Iris, scoped to the active project. */
export async function chat(content: string, projectId?: string): Promise<ChatResponse> {
  return json(await postJson("/api/chat", { content, projectId }));
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

/** Lightweight reachability check for a connection indicator. */
export async function ping(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/health`)).ok;
  } catch {
    return false;
  }
}
