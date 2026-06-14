// The `test` capability (Tester) — the ONE worker that executes a command: it runs
// the project's CEO-configured test suite in the isolated worktree and reports
// pass/fail. It is NOT agentic (no LLM/CLI) and runs ONLY the exact configured argv,
// confined to the worktree, with a timeout. The result is ADVISORY — it rides the
// step summary as a ✓/✗ glyph; it never opens/decides a gate and never merges
// (the canPush wall is untouched). With no command configured it skips, never
// guessing a default.

import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";
import { defaultCommandRunner, type CommandRunner } from "./run-command.js";

/** Default test timeout — suites can run longer than an edit (10 min). */
export const DEFAULT_TEST_TIMEOUT_MS = 600_000;

export interface TestCapabilityDeps {
  /** Override the command runner (tests). Defaults to the sandboxed runner. */
  readonly run?: CommandRunner;
  readonly timeoutMs?: number;
}

/** Keep a long suite log from bloating the persisted summary — the tail is what matters. */
const SUMMARY_TAIL = 1500;

function tail(s: string): string {
  const t = s.trimEnd();
  return t.length > SUMMARY_TAIL ? `…${t.slice(t.length - SUMMARY_TAIL)}` : t;
}

export class TestCapability implements Capability {
  readonly kind = "test" as const;
  private readonly run: CommandRunner;
  private readonly timeoutMs: number;

  constructor(deps: TestCapabilityDeps = {}) {
    this.run = deps.run ?? defaultCommandRunner;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  async execute(input: CapabilityInput): Promise<CapabilityOutput> {
    const argv = input.testCommand;
    // OPT-IN: with no configured command, run NOTHING — never guess `npm test`.
    if (argv === undefined || argv.length === 0) {
      return {
        artifacts: [],
        summary: "No test command configured for this project — skipped (set testCommand in BUREAU_PROJECTS to run the suite).",
      };
    }

    const display = argv.join(" ");
    const result = await this.run(argv, input.worktreePath, this.timeoutMs, input.onChunk);
    const out = tail(`${result.stdout}\n${result.stderr}`);

    if (result.timedOut) {
      return { artifacts: [], summary: `✗ Tests TIMED OUT after ${this.timeoutMs}ms — \`${display}\` was killed.\n${out}` };
    }
    if (result.code === 0) {
      return { artifacts: [], summary: `✓ Tests passed — \`${display}\` exited 0.\n${out}` };
    }
    // code -1 ⇒ the suite could not run at all (binary missing/unspawnable, or a
    // signal-kill with no output). This is ADVISORY too — NEVER throw: a throw would
    // abort the task and discard the CEO's edit. Surface it as ⚠ at the gate so the
    // CEO sees "tests didn't run" alongside the full diff and decides.
    if (result.code === -1 && result.stdout.trim() === "") {
      const hint =
        process.platform === "win32"
          ? " (on Windows, npm/pnpm/yarn are shims that can't be run directly — configure a node-based command, e.g. [\"node\",\"node_modules/.bin/vitest\",\"run\"])"
          : "";
      return { artifacts: [], summary: `⚠ Could not run the tests — \`${display}\`: ${result.stderr.trim() || "the command could not start"}${hint}` };
    }
    return { artifacts: [], summary: `✗ Tests FAILED — \`${display}\` exited ${result.code}.\n${out}` };
  }
}
