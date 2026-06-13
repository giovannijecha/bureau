// Typed client for the Bureau engine API. The panel imports ONLY @bureau/contracts
// (lint-enforced), so these helpers speak the shared DTOs.

import type { TaskDetail, Message, GateDecisionRequest } from "@bureau/contracts";

const BASE = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4319";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `engine responded ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface SendMessageResult {
  message: Message;
  task: TaskDetail;
}

export async function sendMessage(content: string): Promise<SendMessageResult> {
  return json(
    await fetch(`${BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    })
  );
}

export async function decideGate(
  gateId: string,
  decision: GateDecisionRequest["decision"]
): Promise<TaskDetail> {
  return json(
    await fetch(`${BASE}/api/gates/${encodeURIComponent(gateId)}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    })
  );
}

export async function getTask(id: string): Promise<TaskDetail> {
  return json(await fetch(`${BASE}/api/tasks/${encodeURIComponent(id)}`));
}

/** Retry opening the PR for a task whose push succeeded but PR creation failed. */
export async function retryPr(id: string): Promise<TaskDetail> {
  return json(
    await fetch(`${BASE}/api/tasks/${encodeURIComponent(id)}/retry-pr`, { method: "POST" })
  );
}
