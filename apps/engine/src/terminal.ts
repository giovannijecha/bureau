// Embedded terminal — a human-operated shell console for the active project, over
// a dedicated WebSocket (/terminal). One session per socket: each command runs as a
// fresh shell spawn in the session's cwd (a bare `cd` is intercepted so the working
// directory persists), output streams back live, Ctrl-C kills the running command.
//
// SECURITY: this is the ONLY human-driven command channel. It is localhost-only +
// Origin-locked (see ws-origin.ts) and every command is typed or explicitly confirmed by
// the CEO — Iris can PROPOSE a command but it only runs on the CEO's click, so the
// canPush() agent wall is untouched (no agent can execute autonomously here). Bureau's
// own creds AND common secret-shaped env-var names (see isSecretEnvName) are stripped
// from the child env — advisory hardening, not a denylist guarantee.

import { WebSocketServer, WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface TerminalDeps {
  /** The starting cwd for a project's terminal — its canonical clone, or a safe
   *  fallback when it isn't cloned yet. */
  resolveCwd(projectId: string | undefined): string;
  /** Normalize a (possibly absent/raw) projectId to its canonical registry id, so
   *  the recent-output key matches the id the orchestrator reads on the chat side. */
  resolveId(projectId: string | undefined): string;
}

/** Per-command output cap — guards the socket against `cat hugefile`-style floods. */
const OUTPUT_CAP = 1_000_000;
/** Bureau's own credentials never belong in a shell the CEO drives — always stripped. */
const SCRUB_NAMES = new Set(["ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]);
/** Common secret-shaped env-var names (case-insensitive) — broadens the scrub beyond
 *  Bureau's own keys so the CEO's other secrets (AWS_*, OPENAI_API_KEY, *_TOKEN, …) don't
 *  leak into every child shell. Advisory hardening; canPush() remains the sole push gate. */
const SECRET_NAME_RE = /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|CLIENT[_-]?SECRET|BEARER)/i;
/** Names that match the pattern but are SAFE/needed by legit tooling — never scrubbed. */
const SCRUB_ALLOW = new Set(["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_ASKPASS", "SSH_ASKPASS"]);

/** True if an env-var name looks like a secret that should be kept out of the CEO's shell. */
export function isSecretEnvName(name: string): boolean {
  if (SCRUB_ALLOW.has(name)) return false;
  return SCRUB_NAMES.has(name) || SECRET_NAME_RE.test(name);
}
/** How much recent output to keep per project for Iris's chat context. */
const RECENT_CAP = 4000;

const IS_WIN = process.platform === "win32";
const SHELL_LABEL = IS_WIN ? "powershell" : "sh";

interface Session {
  cwd: string;
  child: ChildProcess | null;
}

export class TerminalHub {
  private readonly wss: WebSocketServer;
  /** Most-recent command + output per project, so Iris can "see" what the CEO ran. */
  private readonly recent = new Map<string, string>();

  constructor(private readonly deps: TerminalDeps) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.onConnect(ws, req as IncomingMessage));
  }

  /** Complete a WebSocket handshake the server's upgrade dispatcher routed to /terminal. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  /** A tail of the most recent terminal activity for a project — fed into Iris's
   *  chat context so she can reference command results. Empty when none. */
  recentOutput(projectId: string | undefined): string {
    return this.recent.get(this.deps.resolveId(projectId)) ?? "";
  }

  close(): void {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }

  private onConnect(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/terminal", "http://localhost");
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const scope = url.searchParams.get("scope") === "system" ? "system" : "project";
    // System = the CEO's real PC shell (opens at home); Project = the active repo's
    // clone. Only the Project terminal's output is fed to Iris (the System shell is the
    // CEO's own machine, unrelated to the repo).
    const startCwd = scope === "system" ? homedir() : this.deps.resolveCwd(projectId);
    const recentKey = scope === "system" ? null : this.deps.resolveId(projectId);
    const session: Session = { cwd: this.safeCwd(startCwd), child: null };

    const send = (frame: Record<string, unknown>): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    send({ type: "ready", cwd: session.cwd, shell: SHELL_LABEL, scope });

    ws.on("message", (raw) => {
      let msg: { type?: string; command?: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "run") this.run(session, recentKey, String(msg.command ?? ""), send);
      else if (msg.type === "signal" && session.child) killTree(session.child, false); // Ctrl-C
    });
    ws.on("close", () => {
      if (session.child) killTree(session.child, true); // tear down the whole tree, not just the shell
      session.child = null;
    });
  }

  /** Pick a real, existing directory to start in — the clone if present, else walk
   *  up to the nearest existing ancestor (e.g. the repos root), never throwing. */
  private safeCwd(p: string): string {
    let cur = p;
    for (let i = 0; i < 8; i++) {
      try {
        if (existsSync(cur) && statSync(cur).isDirectory()) return cur;
      } catch {
        /* keep walking up */
      }
      const parent = resolvePath(cur, "..");
      if (parent === cur) break; // reached the filesystem root
      cur = parent;
    }
    return process.cwd();
  }

  private run(session: Session, recentKey: string | null, command: string, send: (f: Record<string, unknown>) => void): void {
    const cmd = command.trim();
    if (cmd === "") {
      send({ type: "exit", code: 0 });
      return;
    }
    if (session.child) {
      send({ type: "output", data: "A command is already running — press Ctrl-C to stop it.\n" });
      send({ type: "exit", code: 1 });
      return;
    }

    // Intercept a BARE `cd`/`Set-Location <path>` so the cwd persists across commands.
    // Bail out for a compound form (cd X && …, cd X; …) — let the real shell run it
    // (only the cross-command cwd persistence is lost for those, which is fine).
    const cd = /^(?:cd|Set-Location)\s+(.+)$/i.exec(cmd);
    if (cd && !/[&|;<>%]|\$\(|`/.test(cd[1]!)) {
      const target = expandHome(stripQuotes(cd[1]!.trim()));
      const next = isAbsolute(target) ? target : resolvePath(session.cwd, target);
      try {
        if (existsSync(next) && statSync(next).isDirectory()) {
          session.cwd = next;
          send({ type: "cwd", cwd: next });
          send({ type: "exit", code: 0 });
          return;
        }
      } catch {
        /* fall through to the error below */
      }
      send({ type: "output", data: `cd: no such directory: ${target}\n` });
      send({ type: "exit", code: 1 });
      return;
    }

    const { file, args } = shellInvocation(cmd);
    let child: ChildProcess;
    try {
      // detached on posix → the shell leads its own process group, so killTree can
      // signal the whole group (the shell + everything it launched).
      child = spawn(file, args, { cwd: session.cwd, env: scrubbedEnv(), windowsHide: true, ...(IS_WIN ? {} : { detached: true }) });
    } catch (e) {
      send({ type: "output", data: `failed to start shell: ${(e as Error).message}\n` });
      send({ type: "exit", code: -1 });
      return;
    }
    session.child = child;

    let bytes = 0;
    let capped = false;
    const collected: string[] = [];
    const onData = (buf: Buffer): void => {
      if (capped) return;
      const s = buf.toString();
      const remaining = OUTPUT_CAP - bytes;
      const piece = s.length > remaining ? s.slice(0, remaining) : s;
      if (piece) {
        bytes += piece.length;
        send({ type: "output", data: piece });
        collected.push(piece);
      }
      if (piece.length < s.length) {
        capped = true;
        send({ type: "output", data: "\n…[output truncated]\n" });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => send({ type: "output", data: `error: ${err.message}\n` }));
    child.on("close", (code) => {
      session.child = null;
      send({ type: "exit", code: code ?? 0 });
      if (recentKey) this.recent.set(recentKey, tail(`$ ${cmd}\n${collected.join("")}`, RECENT_CAP));
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** How the OS shell runs a one-off command line. This is a TERMINAL — running the
 *  CEO's shell command is the explicit purpose, so shell semantics are intended. */
function shellInvocation(cmd: string): { file: string; args: string[] } {
  if (IS_WIN) return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd] };
  return { file: process.env.SHELL && process.env.SHELL.trim() !== "" ? process.env.SHELL : "/bin/sh", args: ["-c", cmd] };
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Strip Bureau's own creds AND common secret-shaped names BEFORE setting the vars
  // below, so none of the deliberately-set ones can be collaterally removed.
  for (const k of Object.keys(env)) if (isSecretEnvName(k)) delete env[k];
  // Premium output: ask tools to emit ANSI colour even though stdout isn't a TTY, and
  // disable interactive pagers (`git log`/`git diff` would otherwise hang on `less`).
  env.FORCE_COLOR = "1";
  env.CLICOLOR_FORCE = "1";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  if (!env.TERM) env.TERM = "xterm-256color";
  // git ignores FORCE_COLOR — force colour via a config override (git 2.31+) so
  // log/status/diff/branch are colourful by default (the panel renders the ANSI).
  // APPEND at the next free index so a CEO-set GIT_CONFIG_* (the System shell inherits
  // the real env) is preserved, never clobbered.
  const n = parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const base = Number.isInteger(n) && n >= 0 ? n : 0;
  env.GIT_CONFIG_COUNT = String(base + 1);
  env[`GIT_CONFIG_KEY_${base}`] = "color.ui";
  env[`GIT_CONFIG_VALUE_${base}`] = "always";
  return env;
}

/** Kill a spawned shell AND its descendants — Ctrl-C / Stop / disconnect must not
 *  orphan grandchildren (npm, dev servers, builds). `hard` = forceful teardown. */
function killTree(child: ChildProcess, hard: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WIN) {
    // Windows has no process groups for kill() to traverse; taskkill /T kills the tree.
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, hard ? "SIGKILL" : "SIGINT"); // negative pid → the whole process group
  } catch {
    try {
      child.kill(hard ? "SIGKILL" : "SIGINT");
    } catch {
      /* already gone */
    }
  }
}

/** Expand a leading `~` to the home directory (the interceptor handles cd itself, so
 *  the shell never gets a chance to expand it). */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1);
  return s;
}

function tail(s: string, max: number): string {
  return s.length > max ? `…${s.slice(s.length - max)}` : s;
}
