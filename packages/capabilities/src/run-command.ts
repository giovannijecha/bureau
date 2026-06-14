// The ONLY place in Bureau that spawns a non-git, non-claude process — the `test`
// worker's sandboxed command runner. Deliberately argv-based with NO shell, so a
// configured command string can never be interpreted for metacharacters (`;`, `&&`,
// `$()`, backticks, redirects, globs are inert literal args). Mirrors the claude CLI
// runner's lifecycle (timeout → SIGTERM → SIGKILL) but adds POSIX process-group kill
// so a forking test runner (vitest/jest) is fully reaped. Imports node:child_process
// only — no @bureau/* edge (golden rule intact).

import { spawn } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly timedOut: boolean;
}

export type CommandRunner = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  onChunk?: (chunk: string) => void
) => Promise<CommandResult>;

/** Retained-output cap so a chatty/runaway suite can never OOM the engine. */
const OUTPUT_CAP = 256 * 1024;

/** Bureau's OWN credentials must never reach the CEO's test process (or its deps). */
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"] as const;

export const defaultCommandRunner: CommandRunner = (argv, cwd, timeoutMs, onChunk) =>
  new Promise<CommandResult>((resolve) => {
    const [cmd, ...rest] = argv;
    if (cmd === undefined) {
      resolve({ stdout: "", stderr: "empty command", code: -1, timedOut: false });
      return;
    }
    const isWin = process.platform === "win32";
    // Strip Bureau's own secrets from the child env (defense in depth). Other env
    // vars are inherited by design (most suites need PATH etc.) — see README/CLAUDE.md.
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
    for (const k of SCRUBBED_ENV) delete env[k];

    let child;
    try {
      // Spawn the program DIRECTLY with shell:false — the absolute no-injection
      // guarantee on every platform (metacharacters are inert literal args). On
      // Windows, npm/pnpm/yarn are .cmd/.ps1 shims that can't be spawned this way; the
      // capability surfaces that as an advisory ⚠ telling the CEO to configure a
      // node-based command (e.g. ["node","node_modules/.bin/vitest","run"]). We never
      // run through a shell, so a shim never becomes a metacharacter-injection surface.
      child = spawn(cmd, rest, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"], // no stdin — the suite can't block on a prompt
        shell: false, // ← the core guarantee
        windowsHide: true,
        env,
        ...(isWin ? {} : { detached: true }), // POSIX: own process group → reap forked workers
      });
    } catch (err) {
      // Some spawn failures (e.g. EFTYPE on a Windows shim) throw SYNCHRONOUSLY.
      // RESOLVE (never reject) so the contract holds and the capability surfaces it.
      resolve({ stdout: "", stderr: String(err), code: -1, timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (sig: NodeJS.Signals): void => {
      if (closed) return; // never signal a process that already exited (PID-reuse safety)
      if (!isWin && child.pid) {
        try {
          process.kill(-child.pid, sig); // whole group
          return;
        } catch {
          /* fall through to a direct kill */
        }
      }
      child.kill(sig);
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill("SIGTERM");
            killTimer = setTimeout(() => kill("SIGKILL"), 2000);
            killTimer.unref();
          }, timeoutMs)
        : undefined;

    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer); // don't let a deferred SIGKILL fire on a reaped PID
    };

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (stdout.length < OUTPUT_CAP) stdout += s;
      onChunk?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    // RESOLVE (never reject) on async spawn error — ENOENT becomes code -1, and the
    // capability decides how to surface it (a missing binary is operational).
    child.on("error", (err: Error) => {
      closed = true;
      clearTimers();
      resolve({ stdout, stderr: String(err), code: -1, timedOut: false });
    });
    child.on("close", (code: number | null) => {
      closed = true;
      clearTimers();
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
