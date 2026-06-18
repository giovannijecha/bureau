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

// Hosts a project may be cloned from. Allowlist, not blocklist.
const ALLOWED_GIT_HOSTS = new Set(["github.com"]);

/**
 * Validate a CEO-supplied repository URL before it reaches `git clone` / `gh`.
 * ALLOWLIST: https:// on an allowed host (github.com), no embedded credentials.
 * Everything else is refused — `file://` (arbitrary local fs into a browsable clone),
 * `ext::`/`transport::`/`fd::` remote helpers (which git EXECUTES — a no-shell spawn
 * does NOT stop this), scp-like `git@host:path`, a leading "-", and `user:pass@` creds
 * (Bureau stores no secrets). Allowlist-not-blocklist: anything not explicitly
 * https+github is rejected.
 */
export function assertSafeRepoUrl(value: string, what = "repository URL"): void {
  const v = value.trim();
  if (v === "" || v.startsWith("-")) throw new VcsError(`Unsafe ${what}: use an https://github.com/owner/repo URL.`);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new VcsError(`Unsafe ${what} "${value}": not a valid URL — use https://github.com/owner/repo.`);
  }
  if (url.protocol !== "https:") throw new VcsError(`Unsafe ${what}: only https:// is allowed (got "${url.protocol}").`);
  if (url.username !== "" || url.password !== "") throw new VcsError(`Unsafe ${what}: remove credentials from the URL — Bureau stores no secrets.`);
  if (!ALLOWED_GIT_HOSTS.has(url.hostname.toLowerCase())) throw new VcsError(`Unsafe ${what}: host "${url.hostname}" is not allowed (only github.com).`);
}

/**
 * Validate a derived GitHub owner/repo identity. Enforces GitHub's naming rules AND
 * keeps the on-disk slug safe (no "/", "\\", whitespace, NUL, leading "-", ".", "..").
 */
export function assertSafeRepoId(owner: string, name: string, what = "repository"): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new VcsError(`Unsafe ${what} owner "${owner}": expected a GitHub login (alphanumeric or hyphen, ≤39 chars, no leading "-").`);
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name.startsWith("-") || name === "." || name === "..") {
    throw new VcsError(`Unsafe ${what} name "${name}": expected a GitHub repo name (alphanumeric plus ".", "_", "-"; no leading "-", not "." or "..").`);
  }
}

/**
 * Parse + validate an https GitHub URL into its { owner, name }. Throws VcsError on
 * anything unsafe — so the clone source and the `gh --repo` target are one identity
 * derived from the same validated URL (never trusted from the client).
 */
export function parseGithubRepo(url: string): { owner: string; name: string } {
  assertSafeRepoUrl(url);
  const parts = new URL(url.trim()).pathname.split("/").filter(Boolean); // ["owner","repo(.git)", ...]
  if (parts.length < 2) throw new VcsError(`Unsafe repository URL "${url}": expected https://github.com/owner/repo.`);
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/i, "");
  assertSafeRepoId(owner, name);
  return { owner, name };
}
