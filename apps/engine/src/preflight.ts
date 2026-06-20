// Boot self-check — fail fast and LOUD on a misconfiguration that would otherwise degrade
// silently, instead of discovering it mid-task. Two layers:
//   FATAL (refuse to serve): git can't be spawned from the engine's PATH, or a data path
//     lives on the WSL Windows mount (/mnt/…), where the SQLite WAL + git worktrees corrupt
//     or hang on the 9p filesystem.
//   WARNINGS (log loudly, keep serving): the per-stack provisioning programs (bun/pnpm/…)
//     and gh that aren't spawnable, and CWD-relative data paths under WSL.
//
// Every tool is probed through the SAME shell-free argv runner the workers use, so the check
// sees exactly what `provision`/`test`/the VCS see at runtime — a probe that went through a
// shell would pass while the real shell:false spawn still ENOENTs (the bug WSL was meant to fix).

import { readFileSync } from "node:fs";
// The /mnt 9p hazard is a POSIX/WSL filesystem concept, so reason about those paths with
// posix semantics explicitly — never the host's path module (the engine runs on Linux, but
// tests run on Windows where win32 `resolve` would mangle a POSIX path like /mnt/c/…).
import { posix } from "node:path";
import { defaultCommandRunner, type CommandRunner } from "@bureau/capabilities";

/** The per-stack install programs `provision` spawns. Advisory: a Bureau instance only needs
 *  the ones its projects actually use, so a missing one warns rather than blocks. */
export const PROVISION_TOOLS = ["bun", "pnpm", "npm", "yarn", "go", "cargo", "pip", "bundle"] as const;

export interface PreflightInput {
  readonly paths: { readonly db: string; readonly reposRoot: string; readonly vault: string };
  /** Configured git/gh programs (BUREAU_GIT_PATH/BUREAU_GH_PATH, default "git"/"gh"). */
  readonly gitPath: string;
  readonly ghPath: string;
  /** Injected for tests; default to the real shell-free runner + live WSL detection + cwd. */
  readonly runner?: CommandRunner;
  readonly isWsl?: boolean;
  readonly cwd?: string;
  readonly log?: (msg: string) => void;
}

export interface PreflightResult {
  /** false ⇒ a FATAL problem; the caller must refuse to serve. */
  readonly ok: boolean;
  readonly fatal: readonly string[];
  readonly warnings: readonly string[];
  /** program → spawnable. */
  readonly toolchain: Readonly<Record<string, boolean>>;
}

/** Running under WSL? The /mnt bleed + 9p WAL hazards only apply there. */
export function detectWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** Is `prog` spawnable via the SAME shell-free runner the workers use? A code of -1 is the
 *  runner's "couldn't spawn" (ENOENT) signal; any real exit code means the binary resolved. */
async function isSpawnable(runner: CommandRunner, prog: string, cwd: string): Promise<boolean> {
  // `--version` is accepted by most tools; even one that rejects the flag still SPAWNS
  // (code ≠ -1), which is all we test. The runner returns code -1 for an unspawnable program
  // (ENOENT) — but ALSO for a probe it had to kill on timeout, where `timedOut` is set. A
  // binary that timed out DID start (it just hung), so treat that as present: we must never
  // refuse boot because a real `git` was momentarily slow (cold cache, loaded systemd boot).
  const r = await runner([prog, "--version"], cwd, 5_000);
  return r.timedOut || r.code !== -1;
}

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const runner = input.runner ?? defaultCommandRunner;
  const isWsl = input.isWsl ?? detectWsl();
  const cwd = input.cwd ?? process.cwd();
  const log = input.log ?? ((m: string): void => console.log(m));

  const fatal: string[] = [];
  const warnings: string[] = [];

  // 1) Data paths — never on the WSL Windows mount (SQLite WAL on 9p corrupts/hangs).
  if (isWsl) {
    const labeled: ReadonlyArray<readonly [string, string]> = [
      ["BUREAU_DB", input.paths.db],
      ["BUREAU_REPOS_ROOT", input.paths.reposRoot],
      ["BUREAU_VAULT", input.paths.vault],
    ];
    for (const [name, p] of labeled) {
      const abs = posix.resolve(cwd, p);
      if (abs === "/mnt" || abs.startsWith("/mnt/")) {
        fatal.push(
          `${name} resolves to ${abs} — on WSL that is the Windows 9p mount, where the SQLite WAL and git worktrees corrupt or hang. Put it under your Linux home (e.g. ~/.bureau-data).`
        );
      } else if (!posix.isAbsolute(p)) {
        warnings.push(
          `${name} ("${p}") is relative — it follows the launch directory; set an absolute Linux path so it can't drift onto /mnt.`
        );
      }
    }
  }

  // 2) Toolchain — probed through the real shell-free spawn path, in parallel.
  const probe = async (prog: string): Promise<readonly [string, boolean]> => [prog, await isSpawnable(runner, prog, cwd)];
  const results = await Promise.all([probe(input.gitPath), probe(input.ghPath), ...PROVISION_TOOLS.map((t) => probe(t))]);
  const toolchain: Record<string, boolean> = {};
  for (const [prog, ok] of results) toolchain[prog] = ok;

  // git is the substrate of every task (worktrees, diffs, commits, lands) — its absence is fatal.
  if (!toolchain[input.gitPath]) {
    fatal.push(
      `git ("${input.gitPath}") is not spawnable from the engine's PATH — no task can run. Put git on PATH or set BUREAU_GIT_PATH to its absolute path.`
    );
  }
  // gh only bites at the push/PR step (which surfaces its own honest error) — warn, don't block.
  if (!toolchain[input.ghPath]) {
    warnings.push(`gh ("${input.ghPath}") is not spawnable — opening/merging PRs will fail. Put gh on PATH or set BUREAU_GH_PATH.`);
  }
  const missingStacks = PROVISION_TOOLS.filter((t) => !toolchain[t]);
  if (missingStacks.length > 0) {
    warnings.push(
      `Not on the engine PATH: ${missingStacks.join(", ")} — repos of those stacks can't be auto-provisioned (verify will report deps couldn't be installed). Expected if you don't use them.`
    );
  }

  // Always surface the PATH + what resolved — a /mnt-polluted or wrong-order PATH is visible here.
  log(`[preflight] PATH=${process.env.PATH ?? "(unset)"}`);
  const avail = Object.entries(toolchain)
    .filter(([, ok]) => ok)
    .map(([t]) => t);
  log(`[preflight] spawnable: ${avail.join(", ") || "(none)"}${isWsl ? " | WSL detected" : ""}`);
  for (const w of warnings) log(`[preflight] ⚠ ${w}`);

  return { ok: fatal.length === 0, fatal, warnings, toolchain };
}
