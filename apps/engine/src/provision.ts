// Worktree dependency provisioning — the foundation the verify loop stands on.
//
// A fresh `git worktree add` contains the repo's source at a ref but NO installed
// dependencies (node_modules / vendor / site-packages are .gitignored). So build/test/verify
// commands fail with module-not-found until something installs them. A direct CLI session
// just runs `bun install`; Bureau must do the same before its checks can mean anything.
//
// This detects the project's stack from marker files and runs the matching install command
// through the SAME sandboxed argv-only runner the test/verify workers use (run-command.ts:
// shell:false, Bureau's own secrets scrubbed, output capped, SIGTERM→SIGKILL). It NEVER runs
// a shell and NEVER touches git/push — it only installs dependencies inside the task worktree.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultCommandRunner, type CommandRunner } from "@bureau/capabilities";

export interface DetectedProvision {
  /** Short stack label for messages (e.g. "bun", "npm", "pip"). */
  readonly stack: string;
  /** The install command (already tokenized argv). */
  readonly command: readonly string[];
}

export interface ProvisionResult {
  /** No stack detected ⇒ nothing to install (NOT a failure). */
  readonly skipped: boolean;
  readonly stack?: string;
  readonly command?: readonly string[];
  /** true ⇒ skipped OR the install exited 0; false ⇒ the install failed / couldn't run. */
  readonly ok: boolean;
  /** Tail of combined stdout+stderr (diagnostics for the gate / a failed-install notice). */
  readonly output: string;
}

/** Does package.json signal a Bun project even without a committed lockfile? (Dante doesn't
 *  commit bun.lockb but its scripts run `bun …`.) Best-effort: never throws. */
function pkgUsesBun(worktreePath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(worktreePath, "package.json"), "utf8")) as {
      packageManager?: unknown;
      scripts?: Record<string, unknown>;
    };
    if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun")) return true;
    if (pkg.scripts && typeof pkg.scripts === "object") {
      for (const v of Object.values(pkg.scripts)) {
        if (typeof v === "string" && /\bbun\b/.test(v)) return true;
      }
    }
  } catch {
    /* malformed/absent package.json — not a bun signal */
  }
  return false;
}

/** Detect the install command for a worktree's stack, or null when there's nothing to install
 *  (no recognized manifest). Pure (only stats/reads marker files). Ordered most-specific first;
 *  a CEO override (project.provisionCommand) should take precedence over this at the call site. */
export function detectProvision(worktreePath: string): DetectedProvision | null {
  const has = (f: string): boolean => existsSync(join(worktreePath, f));

  if (has("package.json")) {
    // Bun first — its lockfile is binary (bun.lockb) or text (bun.lock); also infer from bunfig
    // or package.json scripts so a repo that doesn't commit a lockfile (e.g. Dante) still works.
    if (has("bun.lockb") || has("bun.lock") || has("bunfig.toml") || pkgUsesBun(worktreePath)) {
      return { stack: "bun", command: ["bun", "install"] };
    }
    if (has("pnpm-lock.yaml")) return { stack: "pnpm", command: ["pnpm", "install", "--frozen-lockfile"] };
    if (has("yarn.lock")) return { stack: "yarn", command: ["yarn", "install", "--immutable"] };
    if (has("package-lock.json")) return { stack: "npm", command: ["npm", "ci"] };
    return { stack: "npm", command: ["npm", "install"] }; // package.json, no lockfile
  }
  if (has("go.mod")) return { stack: "go", command: ["go", "mod", "download"] };
  if (has("Cargo.toml")) return { stack: "cargo", command: ["cargo", "fetch"] };
  if (has("requirements.txt")) return { stack: "pip", command: ["pip", "install", "-r", "requirements.txt"] };
  if (has("Gemfile")) return { stack: "bundler", command: ["bundle", "install"] };
  return null;
}

const SUMMARY_TAIL = 2000;

function tail(s: string): string {
  const t = s.trimEnd();
  return t.length > SUMMARY_TAIL ? `…${t.slice(t.length - SUMMARY_TAIL)}` : t;
}

/** Install the worktree's dependencies. `override` (a CEO-configured argv) wins over detection;
 *  otherwise the stack is auto-detected. Streams progress via onChunk. NEVER throws — a failed
 *  or unspawnable install resolves with ok:false so the caller can mark deps not-ready (and the
 *  verify loop then treats check failures as environmental, not code bugs). */
export async function provision(
  worktreePath: string,
  opts: {
    readonly override?: readonly string[] | undefined;
    readonly runner?: CommandRunner;
    readonly timeoutMs?: number;
    readonly onChunk?: (chunk: string) => void;
  } = {}
): Promise<ProvisionResult> {
  const run = opts.runner ?? defaultCommandRunner;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 600_000;

  const detected: DetectedProvision | null =
    opts.override && opts.override.length > 0
      ? { stack: "configured", command: opts.override }
      : detectProvision(worktreePath);

  if (!detected) return { skipped: true, ok: true, output: "" };

  const { stack, command } = detected;
  const display = command.join(" ");
  opts.onChunk?.(`\nInstalling ${stack} dependencies — \`${display}\`…\n`);
  const result = await run(command, worktreePath, timeoutMs, opts.onChunk);
  const out = tail(`${result.stdout}\n${result.stderr}`.trim());

  if (result.code === 0 && !result.timedOut) {
    opts.onChunk?.(`\n✓ Dependencies installed.\n`);
    return { skipped: false, stack, command, ok: true, output: out };
  }
  const why = result.timedOut
    ? `timed out after ${Math.round(timeoutMs / 1000)}s`
    : result.code === -1
      ? `could not run (${result.stderr.trim() || "the command could not be spawned"})`
      : `exited ${result.code}`;
  opts.onChunk?.(`\n✗ Dependency install failed — \`${display}\` ${why}.\n`);
  return { skipped: false, stack, command, ok: false, output: out };
}
