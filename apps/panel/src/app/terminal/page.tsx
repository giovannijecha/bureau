"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Trash2, CircleStop, FolderGit2, Monitor } from "lucide-react";
import { useProjects } from "../../lib/useProjects";
import { IrisDock } from "../../components/IrisDock";
import { AnsiText } from "../../components/AnsiText";
import { ENGINE_URL } from "../../lib/api";
import { cn } from "../../lib/utils";

const WS_BASE = ENGINE_URL.replace(/^http/, "ws");

type Scope = "project" | "system";

type EntryData =
  | { kind: "command"; text: string }
  | { kind: "output"; text: string }
  | { kind: "note"; text: string; tone: "muted" | "error" };
type Entry = EntryData & { id: number };

// The scrollback survives refresh AND scope switches by persisting per scope+project
// in localStorage (each scope keeps its own history). Bounded so it never bloats.
const TERM_CAP = 120_000;
const termKey = (scope: Scope, projectId: string | null | undefined) => `bureau.terminal.${scope}.${projectId ?? "none"}`;

function loadEntries(scope: Scope, projectId: string | null | undefined): Entry[] {
  try {
    const raw = window.localStorage.getItem(termKey(scope, projectId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    return [];
  }
}

function saveEntries(scope: Scope, projectId: string | null | undefined, entries: Entry[]): void {
  try {
    let list = entries.length > 300 ? entries.slice(entries.length - 300) : entries;
    let json = JSON.stringify(list);
    while (json.length > TERM_CAP && list.length > 1) {
      list = list.slice(Math.ceil(list.length / 4)); // drop the oldest quarter until it fits
      json = JSON.stringify(list);
    }
    window.localStorage.setItem(termKey(scope, projectId), json);
  } catch {
    /* storage full / unavailable — skip persistence */
  }
}

export default function TerminalPage() {
  const { active, activeId } = useProjects();
  const [scope, setScope] = useState<Scope>("project");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cwd, setCwd] = useState<string>("");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const seq = useRef(0);
  const outId = useRef<number | null>(null); // entry currently accumulating output
  const runningRef = useRef(false);
  const history = useRef<string[]>([]);
  const histPos = useRef<number>(-1);
  const pendingRun = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipPersist = useRef(true); // don't re-save the scrollback we just restored

  const push = useCallback((e: EntryData) => {
    const id = ++seq.current;
    setEntries((prev) => [...prev, { ...e, id }]);
    return id;
  }, []);

  // A command the chat sent us (?run=…) — pre-fill it once the socket is ready.
  useEffect(() => {
    const run = new URLSearchParams(window.location.search).get("run");
    if (run) {
      pendingRun.current = run;
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const runCommand = useCallback(
    (raw: string) => {
      const cmd = raw.trim();
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || runningRef.current) return;
      push({ kind: "command", text: cmd });
      if (cmd !== "") history.current = [cmd, ...history.current.filter((h) => h !== cmd)].slice(0, 100);
      histPos.current = -1;
      outId.current = null;
      runningRef.current = true;
      setRunning(true);
      ws.send(JSON.stringify({ type: "run", command: cmd }));
    },
    [push]
  );

  function appendOutput(data: string) {
    if (!data) return;
    setEntries((prev) => {
      const cur = outId.current !== null ? prev.find((e) => e.id === outId.current) : undefined;
      // Cap each output entry — past ~64KB start a NEW entry so AnsiText never re-parses
      // an ever-growing string on every streamed chunk (which would be O(n²)).
      if (!cur || cur.kind !== "output" || cur.text.length > 64_000) {
        const id = ++seq.current;
        outId.current = id;
        return [...prev, { id, kind: "output", text: data }];
      }
      return prev.map((e) => (e.id === outId.current && e.kind === "output" ? { ...e, text: e.text + data } : e));
    });
  }

  // (Re)connect whenever the active project OR the scope changes.
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Restore this scope+project's saved scrollback (survives refresh + scope switch).
    const restored = loadEntries(scope, activeId);
    setEntries(restored);
    seq.current = restored.reduce((m, e) => Math.max(m, e.id), 0);
    skipPersist.current = true;
    setConnected(false);
    setRunning(false);
    outId.current = null;
    runningRef.current = false;
    history.current = [];
    histPos.current = -1;

    const connect = () => {
      if (disposed) return;
      const params = new URLSearchParams();
      if (scope === "system") params.set("scope", "system");
      else if (activeId) params.set("projectId", activeId);
      const ws = new WebSocket(`${WS_BASE}/terminal?${params.toString()}`);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        let f: { type?: string; data?: string; cwd?: string; shell?: string; code?: number };
        try {
          f = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (f.type === "ready") {
          setConnected(true);
          setCwd(f.cwd ?? "");
          if (pendingRun.current) {
            const cmd = pendingRun.current;
            pendingRun.current = null;
            setInput(cmd);
            push({ kind: "note", tone: "muted", text: "Iris proposed this command — review it and press Enter to run." });
            inputRef.current?.focus();
          }
        } else if (f.type === "output") {
          appendOutput(f.data ?? "");
        } else if (f.type === "cwd") {
          setCwd(f.cwd ?? "");
        } else if (f.type === "exit") {
          outId.current = null;
          setRunning(false);
          runningRef.current = false;
          if (typeof f.code === "number" && f.code !== 0) push({ kind: "note", tone: "error", text: `exited with code ${f.code}` });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        setRunning(false);
        runningRef.current = false;
        if (!disposed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, scope]);

  // Keep the newest line (and the prompt) in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, running, connected]);

  // Persist the scrollback (debounced) so it survives refresh + scope switches.
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    const t = setTimeout(() => saveEntries(scope, activeId, entries), 400);
    return () => clearTimeout(t);
  }, [entries, scope, activeId]);

  // Focus the inline prompt whenever it's the user's turn (idle + connected).
  useEffect(() => {
    if (connected && !running) inputRef.current?.focus();
  }, [connected, running]);

  function onSubmit() {
    if (running) return;
    const cmd = input;
    setInput("");
    runCommand(cmd);
  }

  function interrupt() {
    wsRef.current?.send(JSON.stringify({ type: "signal", signal: "SIGINT" }));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    } else if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      if (running && !window.getSelection()?.toString()) {
        e.preventDefault();
        interrupt();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(histPos.current + 1, history.current.length - 1);
      if (next >= 0) {
        histPos.current = next;
        setInput(history.current[next]!);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(histPos.current - 1, -1);
      histPos.current = next;
      setInput(next >= 0 ? history.current[next]! : "");
    }
  }

  // Click anywhere in the scrollback to focus the prompt — unless selecting text.
  function focusPrompt() {
    if (!window.getSelection()?.toString()) inputRef.current?.focus();
  }

  // Iris (right column) proposes a command → PRE-FILL the terminal input (the CEO
  // presses Enter). Never auto-runs — the security model stays intact.
  const runFromIris = useCallback((cmd: string) => {
    setInput(cmd);
    inputRef.current?.focus();
  }, []);

  const promptCwd = shortPath(cwd);
  // Catppuccin Mocha — a soft pastel terminal theme (base #1e1e2e, text #cdd6f4).
  const tab = (on: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors",
      on ? "bg-[#45475a] text-[#cdd6f4] shadow-sm" : "text-[#7f849c] hover:text-[#bac2de]"
    );

  return (
    <div className="flex h-full gap-3 p-3 sm:p-6">
      {/* Left: the terminal — Catppuccin Mocha surface. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#313244] bg-[#1e1e2e] shadow-2xl">
        {/* Title bar — traffic lights, scope switch, connection, cwd, actions. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#313244] bg-[#181825] px-3 py-2.5 sm:gap-3 sm:px-4">
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex" aria-hidden>
            <span className="h-3 w-3 rounded-full bg-[#f38ba8]" />
            <span className="h-3 w-3 rounded-full bg-[#f9e2af]" />
            <span className="h-3 w-3 rounded-full bg-[#a6e3a1]" />
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-[#313244]/50 p-0.5 text-xs">
            <button onClick={() => setScope("project")} className={tab(scope === "project")}>
              <FolderGit2 className="h-3.5 w-3.5" /> Project
            </button>
            <button onClick={() => setScope("system")} className={tab(scope === "system")}>
              <Monitor className="h-3.5 w-3.5" /> System
            </button>
          </div>
          <code className="hidden min-w-0 flex-1 truncate font-mono text-xs text-[#6c7086] md:block" title={cwd}>
            {cwd}
          </code>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {running && (
              <button
                onClick={interrupt}
                className="inline-flex items-center gap-1 rounded-md border border-[#313244] px-2 py-1 text-xs font-medium text-[#f38ba8] transition-colors hover:bg-[#f38ba8]/10"
                title="Stop the running command (Ctrl-C)"
              >
                <CircleStop className="h-3.5 w-3.5" /> Stop
              </button>
            )}
            <button
              onClick={() => setEntries([])}
              className="inline-flex items-center gap-1 rounded-md border border-[#313244] px-2 py-1 text-xs font-medium text-[#7f849c] transition-colors hover:bg-[#313244]/60 hover:text-[#cdd6f4]"
              title="Clear the screen"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          </div>
        </div>

        {/* Scrollback — output AND the live prompt flow together, top to bottom. */}
        <div
          ref={scrollRef}
          onClick={focusPrompt}
          className="min-h-0 flex-1 cursor-text space-y-0.5 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-[#cdd6f4]"
        >
          {entries.length === 0 && (
            <p className="text-[#6c7086]">
              {scope === "system" ? (
                <>Your computer&apos;s shell, starting at your home directory. Run anything you&apos;d run in a real terminal.</>
              ) : (
                <>
                  A shell in <span className="text-[#a6e3a1]">{active ? `${active.owner}/${active.name}` : "your project"}</span>&apos;s clone
                  — for inspecting the repo (git status, log, ls…). Iris can also propose read-only commands you run here.
                </>
              )}
            </p>
          )}
          {entries.map((e) => {
            if (e.kind === "command")
              return (
                <div key={e.id} className="flex gap-2 whitespace-pre-wrap break-words">
                  <span className="shrink-0 select-none text-[#a6e3a1]">❯</span>
                  <span className="text-[#cdd6f4]">{e.text}</span>
                </div>
              );
            if (e.kind === "note")
              return (
                <div key={e.id} className={cn("whitespace-pre-wrap break-words", e.tone === "error" ? "text-[#f38ba8]" : "text-[#6c7086]")}>
                  {e.text}
                </div>
              );
            return (
              <div key={e.id} className="whitespace-pre-wrap break-words text-[#bac2de]">
                <AnsiText text={e.text} />
              </div>
            );
          })}

          {/* The live line: an inline prompt when it's your turn, a cursor while busy. */}
          {!connected ? (
            <div className="text-[#6c7086]">connecting…</div>
          ) : running ? (
            <div className="flex items-center gap-2 text-[#6c7086]">
              <span className="inline-block h-4 w-2 animate-pulse bg-[#cba6f7]" />
              <span className="text-xs">running… press Ctrl-C to stop</span>
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 select-none text-[#a6e3a1]" title={cwd}>
                {promptCwd} <span className="text-[#6c7086]">❯</span>
              </span>
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                className="min-w-0 flex-1 bg-transparent text-[#cdd6f4] caret-[#cba6f7] outline-none"
              />
            </div>
          )}
        </div>

        {/* Status bar — connection, scope, and the standing security note. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-[#313244] bg-[#181825] px-3 py-1.5 text-[11px] text-[#6c7086]">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-[#a6e3a1]" : "animate-pulse bg-[#fab387]")} />
            {connected ? "connected" : "connecting…"}
          </span>
          <span className="text-[#45475a]">·</span>
          <span>{scope === "system" ? "your machine's shell" : "the active project's clone"}</span>
          <span className="text-[#45475a]">·</span>
          <span>secrets stripped · repo changes go through tasks</span>
        </div>
      </div>

      {/* Right: work inline with Iris (hidden on narrow screens). */}
      <div className="hidden w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:flex">
        <IrisDock projectId={activeId} onRunCommand={runFromIris} />
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** A compact cwd for the prompt — the last 1–2 path segments. */
function shortPath(p: string): string {
  if (!p) return "~";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}
