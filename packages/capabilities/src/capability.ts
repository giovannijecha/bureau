import type { CapabilityKind, Step, Artifact } from "@bureau/core";

export interface CapabilityInput {
  readonly step: Step;
  readonly worktreePath: string;
  readonly context: string;
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
