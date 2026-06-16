"use client";

// Runs a command the CEO STAGED in the Iris chat — reusing the SAME terminal WebSocket
// the embedded terminal uses (so the security model is identical: localhost + Origin-
// locked, Bureau's secrets scrubbed by the engine, output capped). Two-state by design:
// it mounts STAGED (shows the command + Run/Cancel) and only executes on the explicit
// Run click — an unmistakable confirm-to-execute, in the chat, no accidental fires.
// Read-only inspection by intent — Iris is told never to propose a mutating command.

import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Square, X, Terminal as TerminalIcon, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { ENGINE_URL } from "../lib/api";
import { AnsiText } from "./AnsiText";
import { cn } from "../lib/utils";

const WS_BASE = ENGINE_URL.replace(/^http/, "ws");
/** Keep the rendered output bounded in the chat DOM (the engine also caps at ~1MB). */
const OUT_CAP = 200_000;

type Status = "staged" | "running" | "done" | "stopped" | "error";

export function RunCommand({ command, projectId, onDismiss }: { command: string; projectId: string | undefined; onDismiss: () => void }) {
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<Status>("staged");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);

  // Close the socket if the card unmounts mid-run (thread switch / new chat).
  useEffect(() => () => wsRef.current?.close(), []);

  const run = () => {
    if (status !== "staged") return; // the explicit confirm — runs once, only on this click
    setStatus("running");
    setOutput("");
    setExitCode(null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${WS_BASE}/terminal?projectId=${encodeURIComponent(projectId ?? "")}&scope=project`);
    } catch {
      setStatus("error");
      return;
    }
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      let f: { type?: string; data?: string; code?: number };
      try {
        f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as typeof f;
      } catch {
        return;
      }
      if (f.type === "ready") ws.send(JSON.stringify({ type: "run", command }));
      else if (f.type === "output") {
        const chunk = f.data ?? "";
        setOutput((o) => {
          const room = OUT_CAP - o.length;
          if (room <= 0) return o;
          if (chunk.length > room) setTruncated(true);
          return o + chunk.slice(0, room);
        });
      } else if (f.type === "exit") {
        setExitCode(f.code ?? 0);
        setStatus(stoppedRef.current ? "stopped" : "done");
        ws.close();
      }
    };
    ws.onerror = () => setStatus((s) => (s === "running" ? "error" : s));
    // A close WITHOUT a preceding exit = a dropped connection → surface it as an error,
    // never a phantom "exit" with no code.
    ws.onclose = () => setStatus((s) => (s === "running" ? "error" : s));
  };

  const stop = () => {
    stoppedRef.current = true;
    try {
      wsRef.current?.send(JSON.stringify({ type: "signal" })); // Ctrl-C
    } catch {
      /* socket already gone */
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 font-mono text-xs">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        <code className="min-w-0 flex-1 truncate text-neutral-300">{command}</code>

        {status === "staged" && (
          <>
            <button
              onClick={run}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-600/50 bg-emerald-600/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-600/25"
            >
              <Play className="h-3 w-3" /> Run
            </button>
            <button
              onClick={onDismiss}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-neutral-400 transition-colors hover:text-neutral-200"
            >
              Cancel
            </button>
          </>
        )}
        {status === "running" && (
          <>
            <button
              onClick={stop}
              className="inline-flex items-center gap-1 rounded-md border border-red-600/40 px-2 py-1 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" />
          </>
        )}
        {status === "done" && (
          <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11px]", exitCode === 0 ? "text-emerald-400" : "text-red-400")}>
            {exitCode === 0 ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} exit {exitCode}
          </span>
        )}
        {status === "stopped" && <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-amber-400"><Square className="h-3 w-3" /> stopped</span>}
        {status === "error" && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-amber-400">
            <AlertTriangle className="h-3 w-3" /> disconnected — result unknown
          </span>
        )}
        {(status === "done" || status === "stopped" || status === "error") && (
          <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-neutral-500 transition-colors hover:text-neutral-200">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {status !== "staged" && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 leading-relaxed text-neutral-200">
          {output ? <AnsiText text={output} /> : status === "running" ? <span className="text-neutral-500">running…</span> : <span className="text-neutral-500">(no output)</span>}
          {truncated && <span className="text-amber-400">{"\n…[output truncated]"}</span>}
        </pre>
      )}
    </div>
  );
}
