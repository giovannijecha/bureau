// The closed-loop "verify" helper — runs the project's configured check command(s)
// (build/tests) in the task worktree and reports a STRUCTURED pass/fail plus a digest the
// edit worker can act on. Unlike the advisory `test` capability (a ✓/✗ glyph that
// dead-ends in the step summary), this drives the orchestrator's auto-fix loop: a failure
// feeds its digest back into a re-edit so the CEO reviews code that actually builds/passes.
//
// It is NOT a Capability (no LLM, no registry entry) — just a function the engine calls
// after the edit pipeline. It NEVER touches git/push/merge: it only spawns the exact
// pre-configured argv through the SAME no-shell runner the `test` worker uses (shell:false,
// secrets scrubbed, SIGTERM→SIGKILL). Imports node + run-command only — no @bureau edge
// beyond what `test` already has (golden rule intact).

import { defaultCommandRunner, type CommandRunner } from "./run-command.js";

export interface VerifyFailure {
  /** The argv that failed (already tokenized). */
  readonly command: readonly string[];
  /** Process exit code; -1 ⇒ the command could not be spawned at all. */
  readonly code: number;
  readonly timedOut: boolean;
  /** Tail of the combined stdout+stderr. */
  readonly output: string;
  /** The command could not even START (missing binary, Windows shim, unspawnable). This is
   *  a project-CONFIG problem, not a code bug — re-editing can't fix it, so the loop must
   *  surface it and stop rather than burn fix attempts. */
  readonly couldNotRun: boolean;
}

export interface VerifyResult {
  readonly passed: boolean;
  /** How many commands actually ran (incl. the failing one) — 0 ⇒ nothing was configured. */
  readonly ranCount: number;
  readonly failure?: VerifyFailure;
  /** "" when passed; otherwise an edit-worker-ready brief describing the failure. */
  readonly digest: string;
}

/** Tail of captured output kept in the digest fed back to the edit worker (bounded so the
 *  re-edit prompt can't blow up on a chatty build). */
const DIGEST_TAIL = 4000;

function tail(s: string, max = DIGEST_TAIL): string {
  const t = s.trimEnd();
  return t.length > max ? `…${t.slice(t.length - max)}` : t;
}

/** Run each command in order, STOPPING at the first failure (later checks are moot until the
 *  earlier one passes). Each command gets its own timeout via the runner. Returns a structured
 *  verdict plus a digest the orchestrator can hand to a re-edit. An empty command list ⇒
 *  passed with ranCount 0 (verify is simply skipped — never guessed). */
export async function runVerify(
  commands: readonly (readonly string[])[],
  worktreePath: string,
  timeoutMs: number,
  run: CommandRunner = defaultCommandRunner,
  onChunk?: (chunk: string) => void
): Promise<VerifyResult> {
  let ranCount = 0;
  for (const command of commands) {
    if (command.length === 0) continue;
    ranCount++;
    const display = command.join(" ");
    onChunk?.(`\n$ ${display}\n`);
    const result = await run(command, worktreePath, timeoutMs, onChunk);
    const out = tail(`${result.stdout}\n${result.stderr}`.trim());
    const couldNotRun = result.code === -1 && result.stdout.trim() === "";
    const failed = result.timedOut || result.code !== 0;
    if (failed) {
      const reason = result.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s and was killed`
        : couldNotRun
          ? `could not start (${result.stderr.trim() || "the command could not be spawned"})`
          : `exited ${result.code}`;
      const failure: VerifyFailure = { command, code: result.code, timedOut: result.timedOut, output: out, couldNotRun };
      const digest = couldNotRun
        ? `The configured check could not run: \`${display}\` ${reason}.`
        : [
            `An automated check FAILED. Fix the code so it passes — do NOT weaken, skip, or delete the check itself.`,
            `Command: ${display}`,
            `Result: ${reason}.`,
            `Output (tail):`,
            out || "(no output)",
          ].join("\n");
      return { passed: false, ranCount, failure, digest };
    }
  }
  return { passed: true, ranCount, digest: "" };
}
