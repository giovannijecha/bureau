import type { CapabilityKind, Step, Artifact } from "@bureau/core";

export interface CapabilityInput {
  readonly step: Step;
  readonly worktreePath: string;
  readonly context: string;
  /** The change so far (unified diff) — supplied to workers that assess it (review). */
  readonly diff?: string;
  /** CEO-configured argv for a `test` step (from the project config). Undefined ⇒
   *  the test worker degrades to a "no command configured" skip — it never guesses. */
  readonly testCommand?: readonly string[];
  /** When set, the worker streams its output here as it works (live progress). */
  readonly onChunk?: (chunk: string) => void;
}

export interface CapabilityOutput {
  readonly artifacts: readonly Artifact[];
  readonly summary: string;
  /** Token spend for this step's provider call(s), for usage/cost attribution. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly model: string };
}

export interface Capability {
  readonly kind: CapabilityKind;
  execute(input: CapabilityInput): Promise<CapabilityOutput>;
}
