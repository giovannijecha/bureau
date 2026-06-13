import type { CapabilityKind, Step, Artifact } from "@bureau/core";

export interface CapabilityInput {
  readonly step: Step;
  readonly worktreePath: string;
  readonly context: string;
}

export interface CapabilityOutput {
  readonly artifacts: readonly Artifact[];
  readonly summary: string;
}

export interface Capability {
  readonly kind: CapabilityKind;
  execute(input: CapabilityInput): Promise<CapabilityOutput>;
}
