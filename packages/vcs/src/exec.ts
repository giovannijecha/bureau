// Subprocess plumbing for the git/gh wrappers. The Runner is injectable so the
// git helpers can be unit-tested with a fake and integration-tested against real
// git, without the wrappers themselves knowing which.

import { spawn } from "node:child_process";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type Runner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

export class VcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VcsError";
  }
}

/** Default runner: spawn the command, collect stdout/stderr, resolve with the exit code. */
export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: Error) => resolve({ stdout: "", stderr: String(err), code: -1 }));
    child.on("close", (code: number | null) => resolve({ stdout, stderr, code: code ?? -1 }));
  });

/** Run a command and return stdout, throwing a VcsError on a non-zero exit. */
export async function run(
  runner: Runner,
  cmd: string,
  args: string[],
  cwd?: string
): Promise<string> {
  const result = await runner(cmd, args, cwd !== undefined ? { cwd } : {});
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "(no output)";
    throw new VcsError(`\`${cmd} ${args.join(" ")}\` failed (exit ${result.code}): ${detail}`);
  }
  return result.stdout;
}

/**
 * Build a runner that maps the logical command names "git"/"gh" to configured
 * binaries. On Windows the GitHub CLI may not be a bare `gh` on PATH (or may be
 * a shim node refuses to spawn without a shell), so the engine can inject the
 * full path here without enabling a shell (which would reopen arg injection).
 */
export function makeRunner(opts?: { gitPath?: string; ghPath?: string }): Runner {
  const map: Record<string, string> = {
    git: opts?.gitPath ?? "git",
    gh: opts?.ghPath ?? "gh",
  };
  return (cmd, args, o) => defaultRunner(map[cmd] ?? cmd, args, o);
}

/**
 * Reject anything that isn't a plain git ref before it reaches the command line.
 * `spawn` (no shell) already defeats shell-metacharacter injection; this closes
 * the remaining ARGUMENT-injection hole for refs that can't sit behind a `--`
 * separator (a base/branch like "--output=x" would otherwise be read as a flag).
 */
export function assertSafeRef(value: string, what: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..")) {
    throw new VcsError(
      `Unsafe ${what} "${value}": expected a plain git ref (alphanumeric plus ".", "_", "/", "-"; no leading "-" and no "..").`
    );
  }
}
