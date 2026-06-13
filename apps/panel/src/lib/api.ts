// Typed client for the Bureau engine API. The panel imports ONLY @bureau/contracts.

import type { TaskDetail, TaskSummary, ChatResponse, TaskProposal } from "@bureau/contracts";

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

/** A conversation turn with Iris. */
export async function chat(content: string): Promise<ChatResponse> {
  return json(await postJson("/api/chat", { content }));
}

/** Materialize a proposal into a draft task. */
export async function createTask(proposal: TaskProposal): Promise<TaskDetail> {
  return json(await postJson("/api/tasks", { proposal }));
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
