"use client";

// Runs a command the CEO STAGED in the Iris chat — reusing the SAME terminal WebSocket
// the embedded terminal uses (so the security model is identical: localhost + Origin-
// locked, Bureau's secrets scrubbed by the engine, output capped). Two-state by design:
// it mounts STAGED (shows the command + Run/Cancel) and only executes on the explicit
// Run click — an unmistakable confirm-to-execute, in the chat, no accidental fires.
// Read-only inspection by intent — Iris is told never to propose a mutating command.
//
// REHYDRATED (static) mode: when `initial` is given, the card renders a finished
// transcript with NO socket and NO Run button — a persisted past result, never replayed
// (replaying would auto-execute a command, bypassing the confirm-to-execute gate).
//
// Visually this is the real Bureau Terminal in miniature: same Catppuccin Mocha skin
// (traffic lights, ❯ prompt, status bar) as apps/panel/src/app/terminal/page.tsx, so a
// command run from chat reads exactly like one run on the Terminal page.

import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Square, X, FolderGit2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { ENGINE_URL } from "../lib/api";
import { AnsiText } from "./AnsiText";
import { cn } from "../lib/utils";

const WS_BASE = ENGINE_URL.replace(/^http/, "ws");
/** Keep the rendered + stored output bounded (the engine also caps at ~1MB). */
export const RUN_OUT_CAP = 200_000;

export interface RunResult {
  output: string;
  exitCode: number | null;
  truncated: boolean;
  stopped: boolean;
}

type Status = "staged" | "running" | "done" | "stopped" | "error";

export function RunCommand({
  command,
  projectId,
  onDismiss,
  initial,
  onComplete,
}: {
  command: string;
  projectId: string | undefined;
  onDismiss: () => void;
  /** When present, render a finished transcript statically (no socket, no Run button). */
  initial?: RunResult;
  /** Called once when a LIVE run reaches a terminal state, so the parent can persist it. */
  onComplete?: (r: RunResult) => void;
}) {
  const [output, setOutput] = useState(initial?.output ?? "");
  const [status, setStatus] = useState<Status>(initial ? (initial.stopped ? "stopped" : "done") : "staged");
  const [exitCode, setExitCode] = useState<number | null>(initial?.exitCode ?? null);
  const [truncated, setTruncated] = useState(initial?.truncated ?? false);
  const [cwd, setCwd] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false);

  // Close the socket if a live card unmounts mid-run (thread switch / new chat).
  useEffect(() => () => wsRef.current?.close(), []);

  const run = () => {
    if (status !== "staged") return; // the explicit confirm — runs once, only on this click
    setStatus("running");
    setOutput("");
    setExitCode(null);
    // Accumulate into a local (not the stale `output` state) so onComplete gets the
    // full transcript when the run finishes.
    let acc = "";
    let truncatedLocal = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${WS_BASE}/terminal?projectId=${encodeURIComponent(projectId ?? "")}&scope=project`);
    } catch {
      setStatus("error");
      return;
    }
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      let f: { type?: string; data?: string; cwd?: string; code?: number };
      try {
        f = JSON.parse(typeof ev.data === "string" ? ev.data : "") as typeof f;
      } catch {
        return;
      }
      if (f.type === "ready") {
        if (f.cwd) setCwd(f.cwd);
        ws.send(JSON.stringify({ type: "run", command }));
      } else if (f.type === "output") {
        const room = RUN_OUT_CAP - acc.length;
        if (room <= 0) return;
        const chunk = f.data ?? "";
        if (chunk.length > room) truncatedLocal = true;
        acc += chunk.slice(0, room);
        setOutput(acc);
        if (truncatedLocal) setTruncated(true);
      } else if (f.type === "exit") {
        const code = f.code ?? 0;
        const stopped = stoppedRef.current;
        setExitCode(code);
        setStatus(stopped ? "stopped" : "done");
        ws.close();
        onComplete?.({ output: acc, exitCode: code, truncated: truncatedLocal, stopped });
      }
    };
    // A close/error WITHOUT a preceding exit = a dropped connection → surface it as an
    // error (never a phantom "exit"), and never persist (result unknown).
    ws.onerror = () => setStatus((s) => (s === "running" ? "error" : s));
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

  // Status-dot colour for the footer — mirrors the Terminal page's lifecycle palette.
  const dot =
    status === "running" ? "bg-[#a6e3a1]" :
    status === "done" ? (exitCode === 0 ? "bg-[#a6e3a1]" : "bg-[#f38ba8]") :
    status === "error" ? "bg-[#f38ba8]" :
    "bg-[#fab387]"; // staged | stopped

  return (
    <div className="overflow-hidden rounded-lg border border-[#313244] bg-[#1e1e2e] font-mono text-xs shadow-lg">
      {/* Title bar — traffic lights, scope pill, cwd, and the action/status cluster. */}
      <div className="flex items-center gap-2 border-b border-[#313244] bg-[#181825] px-3 py-2">
        <div className="flex shrink-0 items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-[#f38ba8]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#f9e2af]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#a6e3a1]" />
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#313244]/60 px-2 py-0.5 text-[10px] font-medium text-[#bac2de]">
          <FolderGit2 className="h-3 w-3" /> Project
        </span>
        {cwd && (
          <code className="hidden min-w-0 flex-1 truncate text-[10px] text-[#6c7086] md:block" title={cwd}>
            {cwd}
          </code>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {status === "staged" && (
            <>
              <button
                onClick={run}
                className="inline-flex items-center gap-1 rounded-md border border-[#a6e3a1]/40 bg-[#a6e3a1]/10 px-2.5 py-1 text-[11px] font-semibold text-[#a6e3a1] transition-colors hover:bg-[#a6e3a1]/20"
              >
                <Play className="h-3 w-3" /> Run
              </button>
              <button
                onClick={onDismiss}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[#7f849c] transition-colors hover:text-[#cdd6f4]"
              >
                Cancel
              </button>
            </>
          )}
          {status === "running" && (
            <>
              <button
                onClick={stop}
                className="inline-flex items-center gap-1 rounded-md border border-[#f38ba8]/40 px-2 py-1 text-[11px] font-medium text-[#f38ba8] transition-colors hover:bg-[#f38ba8]/10"
              >
                <Square className="h-3 w-3" /> Stop
              </button>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#6c7086]" />
            </>
          )}
          {status === "done" && (
            <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11px]", exitCode === 0 ? "text-[#a6e3a1]" : "text-[#f38ba8]")}>
              {exitCode === 0 ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} exit {exitCode}
            </span>
          )}
          {status === "stopped" && <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-[#fab387]"><Square className="h-3 w-3" /> stopped</span>}
          {status === "error" && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-[#fab387]">
              <AlertTriangle className="h-3 w-3" /> disconnected — result unknown
            </span>
          )}
          {(status === "done" || status === "stopped" || status === "error") && (
            <button onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-[#6c7086] transition-colors hover:text-[#cdd6f4]">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollback — the ❯ prompt line + the command, then its output, exactly like the
          Terminal page. Staged shows a review note in place of output. */}
      <div className="max-h-72 space-y-1 overflow-auto px-3 py-2.5 leading-relaxed">
        <div className="flex gap-2 whitespace-pre-wrap break-words">
          <span className="shrink-0 select-none text-[#a6e3a1]" title={cwd}>
            {cwd ? <>{shortPath(cwd)} <span className="text-[#6c7086]">❯</span></> : "❯"}
          </span>
          <span className="text-[#cdd6f4]">{command}</span>
        </div>

        {status === "staged" ? (
          <div className="text-[#6c7086]">Iris proposed this command — review it, then press Run.</div>
        ) : (
          <pre className="whitespace-pre-wrap break-words text-[#bac2de]">
            {output ? (
              <AnsiText text={output} />
            ) : status === "running" ? (
              <span className="inline-flex items-center gap-2 text-[#6c7086]">
                <span className="inline-block h-3.5 w-2 animate-pulse bg-[#cba6f7]" /> running…
              </span>
            ) : (
              <span className="text-[#6c7086]">(no output)</span>
            )}
            {truncated && <span className="text-[#fab387]">{"\n…[output truncated]"}</span>}
          </pre>
        )}
      </div>

      {/* Status bar — the standing security note, identical to the Terminal page. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-[#313244] bg-[#181825] px-3 py-1 text-[10px] text-[#6c7086]">
        <span className={cn("h-1.5 w-1.5 rounded-full", status === "running" && "animate-pulse", dot)} aria-hidden />
        <span>the active project&apos;s clone</span>
        <span className="text-[#45475a]">·</span>
        <span>secrets stripped · repo changes go through tasks</span>
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** A compact cwd for the prompt — the last 1–2 path segments (mirrors the Terminal page). */
function shortPath(p: string): string {
  if (!p) return "~";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}
