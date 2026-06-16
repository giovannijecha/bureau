"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Trash2, CircleStop, FolderGit2, Monitor } from "lucide-react";
import { useProjects } from "../../lib/useProjects";
import { IrisDock } from "../../components/IrisDock";
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
  const { projects, active, activeId, setActiveId } = useProjects();
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
  const tab = (on: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors",
      on ? "bg-neutral-700/70 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
    );

  return (
    <div className="flex h-full flex-col gap-2 p-3 sm:p-6">
      <div className="flex min-h-0 flex-1 gap-3">
        {/* Left: the terminal (true black, Bureau style). */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-800 bg-black shadow-2xl">
          {/* Header — scope switch, connection, cwd, actions (no macOS traffic lights). */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 bg-neutral-950/60 px-3 py-2.5 sm:gap-3 sm:px-4">
            <div className="flex shrink-0 items-center rounded-lg border border-neutral-700/60 bg-neutral-900/60 p-0.5 text-xs">
              <button onClick={() => setScope("project")} className={tab(scope === "project")}>
                <FolderGit2 className="h-3.5 w-3.5" /> Project
              </button>
              <button onClick={() => setScope("system")} className={tab(scope === "system")}>
                <Monitor className="h-3.5 w-3.5" /> System
              </button>
            </div>
            <span
              className={cn("h-2 w-2 shrink-0 rounded-full", connected ? "bg-emerald-400" : "animate-pulse bg-amber-400")}
              title={connected ? "connected" : "connecting…"}
            />
            <code className="hidden min-w-0 flex-1 truncate font-mono text-xs text-neutral-500 md:block" title={cwd}>
              {cwd}
            </code>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {running && (
                <button
                  onClick={interrupt}
                  className="inline-flex items-center gap-1 rounded-md border border-neutral-700/60 px-2 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10"
                  title="Stop the running command (Ctrl-C)"
                >
                  <CircleStop className="h-3.5 w-3.5" /> Stop
                </button>
              )}
              <button
                onClick={() => setEntries([])}
                className="inline-flex items-center gap-1 rounded-md border border-neutral-700/60 px-2 py-1 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
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
            className="min-h-0 flex-1 cursor-text space-y-0.5 overflow-y-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-neutral-200"
          >
            {entries.length === 0 && (
              <p className="text-neutral-500">
                {scope === "system" ? (
                  <>Your computer&apos;s shell, starting at your home directory. Run anything you&apos;d run in a real terminal.</>
                ) : (
                  <>
                    A shell in <span className="text-neutral-300">{active ? `${active.owner}/${active.name}` : "your project"}</span>&apos;s
                    clone — for inspecting the repo (git status, log, ls…). Iris can also propose read-only commands you run here.
                  </>
                )}
              </p>
            )}
            {entries.map((e) => {
              if (e.kind === "command")
                return (
                  <div key={e.id} className="flex gap-2 whitespace-pre-wrap break-words">
                    <span className="shrink-0 select-none text-emerald-400">❯</span>
                    <span className="text-neutral-100">{e.text}</span>
                  </div>
                );
              if (e.kind === "note")
                return (
                  <div key={e.id} className={cn("whitespace-pre-wrap break-words", e.tone === "error" ? "text-red-400" : "text-neutral-500")}>
                    {e.text}
                  </div>
                );
              return (
                <div key={e.id} className="whitespace-pre-wrap break-words text-neutral-300">
                  <AnsiText text={e.text} />
                </div>
              );
            })}

            {/* The live line: an inline prompt when it's your turn, a cursor while busy. */}
            {!connected ? (
              <div className="text-neutral-500">connecting…</div>
            ) : running ? (
              <div className="flex items-center gap-2 text-neutral-500">
                <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400" />
                <span className="text-xs">running… press Ctrl-C to stop</span>
              </div>
            ) : (
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 select-none text-emerald-400" title={cwd}>
                  {promptCwd} <span className="text-neutral-600">❯</span>
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
                  className="min-w-0 flex-1 bg-transparent text-neutral-100 caret-emerald-400 outline-none"
                />
              </div>
            )}
          </div>
        </div>
        {/* Right: work inline with Iris (hidden on narrow screens). */}
        <div className="hidden w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:flex">
          <IrisDock projectId={activeId} onRunCommand={runFromIris} projects={projects} active={active} onSelectProject={setActiveId} />
        </div>
      </div>

      <p className="px-1 text-[11px] text-muted-foreground">
        Human-operated · {scope === "system" ? "your machine's shell" : "the active project's clone"} · Bureau secrets are stripped · repo
        changes go through tasks, not the terminal.
      </p>
    </div>
  );
}

// ── ANSI colour rendering ─────────────────────────────────────────────────────

type AnsiStyle = { fg?: string; bold?: boolean; dim?: boolean; underline?: boolean };

const ANSI_FG: Record<number, string> = {
  30: "text-neutral-500", 31: "text-red-400", 32: "text-emerald-400", 33: "text-yellow-400",
  34: "text-blue-400", 35: "text-fuchsia-400", 36: "text-cyan-400", 37: "text-neutral-200",
  90: "text-neutral-400", 91: "text-red-300", 92: "text-emerald-300", 93: "text-yellow-300",
  94: "text-blue-300", 95: "text-fuchsia-300", 96: "text-cyan-300", 97: "text-white",
};

function applySgr(style: AnsiStyle, codeStr: string): AnsiStyle {
  const codes = codeStr === "" ? [0] : codeStr.split(";").map((x) => parseInt(x, 10) || 0);
  let s: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) {
      s.bold = false;
      s.dim = false;
    } else if (c === 24) s.underline = false;
    else if (c === 39) delete s.fg;
    else if (ANSI_FG[c]) s.fg = ANSI_FG[c];
    else if (c === 38 && codes[i + 1] === 5) {
      const mapped = ANSI_FG[codes[i + 2] ?? -1];
      if (mapped) s.fg = mapped;
      else delete s.fg;
      i += 2; // 256-colour → nearest basic (best-effort)
    }
  }
  return s;
}

function styleClass(s: AnsiStyle): string {
  return [s.fg ?? "", s.bold ? "font-semibold" : "", s.dim ? "opacity-70" : "", s.underline ? "underline" : ""].filter(Boolean).join(" ");
}

// ESC is built from a char code so NO literal control byte ever sits in this source.
// The strip/colour regexes are built via `new RegExp` from plain-ASCII strings.
const ESC = String.fromCharCode(27);
const OSC_RE = new RegExp(ESC + "\\][^\\u0007" + ESC + "]*(?:\\u0007|" + ESC + "\\\\)", "g"); // window-title etc.
const CSI_NON_SGR_RE = new RegExp(ESC + "\\[[0-9;?]*[A-HJKSTfhlsu]", "g"); // cursor moves, clears
// Stray control chars (keep \n=0a \t=09). MUST skip ESC=0x1b so the SGR colour loop
// below can still see colour codes — stripping ESC here would kill all colouring.
const CTRL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001a\\u001c-\\u001f\\u007f]", "g");
const SGR_RE = new RegExp(ESC + "\\[([0-9;]*)m", "g"); // colour codes

/** Parse text with ANSI SGR colour codes into styled span nodes (strips OSC/cursor/control). */
function parseAnsi(text: string): ReactNode[] {
  const cleaned = text.replace(OSC_RE, "").replace(CSI_NON_SGR_RE, "").replace(CTRL_RE, "");
  const out: ReactNode[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  let key = 0;
  SGR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushRun = (str: string) => {
    if (!str) return;
    const cls = styleClass(style);
    out.push(
      cls ? (
        <span key={key++} className={cls}>
          {str}
        </span>
      ) : (
        <span key={key++}>{str}</span>
      )
    );
  };
  while ((m = SGR_RE.exec(cleaned)) !== null) {
    pushRun(cleaned.slice(last, m.index));
    style = applySgr(style, m[1] ?? "");
    last = SGR_RE.lastIndex;
  }
  pushRun(cleaned.slice(last));
  return out;
}

/** Memoized so only the entry whose text changed re-parses — settled output isn't re-parsed
 *  on every streamed chunk (and output entries are capped, so a parse stays bounded). */
const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const nodes = useMemo(() => parseAnsi(text), [text]);
  return <>{nodes}</>;
});

/** A compact cwd for the prompt — the last 1–2 path segments. */
function shortPath(p: string): string {
  if (!p) return "~";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}
