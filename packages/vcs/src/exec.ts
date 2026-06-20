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

// Backstops on every git/gh subprocess: a HARD timeout so a wedged process can't hang the
// engine forever, and an output CAP so a runaway command (a pathological diff/log, a gh
// stream) can't grow the buffer until the engine OOMs. Both are far above any healthy run —
// they catch failure, not normal work. A timeout/overflow resolves as a non-zero exit, so
// run() surfaces it as a VcsError with a clear reason (never a silent hang or a partial OK).
const EXEC_TIMEOUT_MS = 600_000; // 10 min — well past any real clone/fetch on this machine
const EXEC_MAX_BYTES = 64 * 1024 * 1024; // 64 MB combined stdout+stderr

/** Default runner: spawn the command, collect stdout/stderr (bounded), resolve with the exit
 *  code — killing the child on timeout or output overflow. */
export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;

    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        stdout,
        stderr: `${stderr}\n(timed out after ${EXEC_TIMEOUT_MS}ms — command killed)`.trim(),
        code: 124 /* conventional timeout exit */,
      });
    }, EXEC_TIMEOUT_MS);

    /** Append a chunk, killing the child if the combined buffer blows the cap. */
    const append = (chunk: Buffer, onto: "stdout" | "stderr") => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > EXEC_MAX_BYTES) {
        child.kill("SIGKILL");
        finish({
          stdout,
          stderr: `${stderr}\n(output exceeded ${EXEC_MAX_BYTES} bytes — command killed)`,
          code: 1,
        });
        return;
      }
      if (onto === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout.on("data", (d: Buffer) => append(d, "stdout"));
    child.stderr.on("data", (d: Buffer) => append(d, "stderr"));
    child.on("error", (err: Error) => finish({ stdout: "", stderr: String(err), code: -1 }));
    child.on("close", (code: number | null) => finish({ stdout, stderr, code: code ?? -1 }));
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

/** Is this error likely a TRANSIENT network/availability failure (worth retrying) rather than a
 *  PERMANENT one (auth, not-found, conflict, protected branch)? Conservative: permanent signals
 *  win, and only well-known retryable signatures return true — so we never mask a real auth/
 *  conflict error as "just a network blip". */
export function isTransient(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(401|403|404|409|422)\b|unauthorized|forbidden|not found|permission denied|authentication|could not read username|merge conflict|non-fast-forward|protected branch|already exists/.test(m)) {
    return false; // permanent — retrying won't help (and could duplicate)
  }
  return /timed out|etimedout|econnreset|econnrefused|enotfound|eai_again|could not resolve host|temporary failure|temporarily unavailable|rate limit|\b429\b|\b50[0-9]\b|connection (reset|closed|refused|timed out)|network is unreachable|\btls\b|\bssl\b/.test(m);
}

/** Retry an IDEMPOTENT remote-touching op (clone, fetch, push) on TRANSIENT failures, with bounded
 *  exponential backoff. Permanent failures throw immediately (no wasted retries). `onRetry` fires
 *  before each retry for logging. NEVER use on non-idempotent ops (openPr/mergePr) — a retry there
 *  could duplicate a PR or double-merge. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, err: unknown) => void }
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const base = opts?.baseDelayMs ?? 300;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts || !isTransient(err)) throw err;
      opts?.onRetry?.(i, err);
      if (base > 0) await new Promise((r) => setTimeout(r, base * 2 ** (i - 1)));
    }
  }
  throw lastErr;
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
