"use client";

// Assistant — the Phase-4 vertical slice. Chat to Iris, review the diff Iris
// prepared in an isolated worktree, and approve to open a real PR (the engine's
// canPush gate authorizes the push only on approval).

import { useState, type CSSProperties } from "react";
import type { TaskDetail, Message } from "@bureau/contracts";
import { sendMessage, decideGate, retryPr } from "../lib/api";

export default function AssistantPage() {
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Message[]>([]);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSend() {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    setLog((l) => [...l, userMessage(content)]);
    setInput("");
    try {
      const { message, task } = await sendMessage(content);
      setLog((l) => [...l, message]);
      setTask(task);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDecide(gateId: string, decision: "approved" | "rejected") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setTask(await decideGate(gateId, decision));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRetry(taskId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setTask(await retryPr(taskId));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const openGate = task?.gates.find((g) => g.status === "open");
  const needsRetry = task?.status === "completed" && !task.prUrl;

  return (
    <main style={S.main}>
      <h1 style={S.h1}>Bureau · Assistant</h1>

      <section style={S.chat}>
        {log.length === 0 && <p style={S.muted}>Tell Iris what change to make on the repo…</p>}
        {log.map((m) => (
          <div key={m.id} style={{ ...S.bubble, ...(m.role === "user" ? S.user : S.iris) }}>
            <strong style={S.role}>{m.role}</strong>
            <span>{m.content}</span>
          </div>
        ))}
      </section>

      <div style={S.composer}>
        <input
          style={S.input}
          value={input}
          placeholder="e.g. add a /health endpoint that returns 200 OK"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          disabled={busy}
        />
        <button style={S.send} onClick={onSend} disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </div>

      {error && <p style={S.error}>⚠ {error}</p>}

      {task && (
        <section style={S.task}>
          <header style={S.taskHead}>
            <span>
              Task <code>{task.id.slice(0, 8)}</code> · <b>{task.status}</b>
            </span>
            <span style={S.muted}>
              {task.repoOwner}/{task.repoName}
            </span>
          </header>

          {task.diff && (
            <pre style={S.diff}>{task.diff || "(no changes)"}</pre>
          )}

          {openGate && (
            <div style={S.gate}>
              <span>Review the diff above. Approving opens the PR.</span>
              <div>
                <button style={S.approve} onClick={() => onDecide(openGate.id, "approved")} disabled={busy}>
                  Approve & open PR
                </button>
                <button style={S.reject} onClick={() => onDecide(openGate.id, "rejected")} disabled={busy}>
                  Reject
                </button>
              </div>
            </div>
          )}

          {needsRetry && (
            <div style={S.gate}>
              <span>The branch was pushed but the PR didn&apos;t open. You can retry.</span>
              <button style={S.approve} onClick={() => onRetry(task.id)} disabled={busy}>
                Retry PR
              </button>
            </div>
          )}

          {task.prUrl && (
            <p style={S.pr}>
              ✅ PR opened:{" "}
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                {task.prUrl}
              </a>
            </p>
          )}
        </section>
      )}
    </main>
  );
}

function userMessage(content: string): Message {
  return { id: `local-${content.length}-${content.slice(0, 8)}`, role: "user", content, createdAt: "" };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const S: Record<string, CSSProperties> = {
  main: { maxWidth: 820, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui, sans-serif" },
  h1: { fontSize: 20, marginBottom: 16 },
  chat: { display: "flex", flexDirection: "column", gap: 8, minHeight: 120, marginBottom: 12 },
  bubble: { padding: "8px 12px", borderRadius: 10, maxWidth: "80%", display: "flex", flexDirection: "column", gap: 2 },
  user: { alignSelf: "flex-end", background: "#e8eefc" },
  iris: { alignSelf: "flex-start", background: "#f2f3f5" },
  role: { fontSize: 11, textTransform: "uppercase", opacity: 0.5 },
  muted: { color: "#888" },
  composer: { display: "flex", gap: 8 },
  input: { flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #ccc", fontSize: 14 },
  send: { padding: "10px 18px", borderRadius: 8, border: "none", background: "#2d6cdf", color: "#fff", cursor: "pointer" },
  error: { color: "#c0392b", marginTop: 8 },
  task: { marginTop: 20, border: "1px solid #e3e3e3", borderRadius: 12, padding: 16 },
  taskHead: { display: "flex", justifyContent: "space-between", marginBottom: 12 },
  diff: { background: "#0d1117", color: "#d6deeb", padding: 12, borderRadius: 8, overflowX: "auto", fontSize: 12, maxHeight: 360 },
  gate: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 12 },
  approve: { padding: "8px 14px", borderRadius: 8, border: "none", background: "#1e9e54", color: "#fff", cursor: "pointer", marginRight: 8 },
  reject: { padding: "8px 14px", borderRadius: 8, border: "1px solid #ccc", background: "#fff", cursor: "pointer" },
  pr: { marginTop: 12, color: "#1e9e54" },
};
