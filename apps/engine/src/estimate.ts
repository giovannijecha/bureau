// Pre-run cost estimate — forecast a proposed task's token spend + USD cost BEFORE the
// CEO creates it, so the decision to run isn't blind. Per step (capability), we use that
// scope's HISTORICAL average when we have enough past runs, else a sensible default. It's
// a forecast, clearly labelled as such — not a quote. Pure: no I/O.

import type { CostEstimate, CostStep } from "@bureau/contracts";
import { DEFAULT_MODEL } from "@bureau/providers";
import { resolveModel, MODEL_SCOPES, type ModelPolicy, type ModelScope } from "./models.js";
import { costUsd } from "./usage.js";

/** Rough default token footprint per capability when we have no history yet — input
 *  includes the repo context + system prompt; output is the produced plan/edit/etc. */
const DEFAULTS: Record<string, { inputTokens: number; outputTokens: number }> = {
  plan: { inputTokens: 12_000, outputTokens: 3_000 },
  research: { inputTokens: 16_000, outputTokens: 4_000 },
  edit: { inputTokens: 24_000, outputTokens: 6_000 },
  review: { inputTokens: 12_000, outputTokens: 2_000 },
  document: { inputTokens: 12_000, outputTokens: 3_000 },
};
const FALLBACK = { inputTokens: 12_000, outputTokens: 3_000 };
/** Need at least this many past runs of a scope before trusting its average over the default. */
const MIN_SAMPLES = 3;

export interface ScopeAverage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly events: number;
}

const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/**
 * Estimate a task's cost from its pipeline. `averages` maps a scope (capability) to its
 * cumulative token totals + event count (from usage history); a scope with ≥ MIN_SAMPLES
 * events uses its mean, otherwise the static default. Capabilities that make NO model call
 * (the `test` worker runs the suite) contribute zero cost.
 */
export function estimateTaskCost(
  capabilities: readonly string[],
  policy: ModelPolicy,
  averages: ReadonlyMap<string, ScopeAverage>
): CostEstimate {
  const perStep: CostStep[] = capabilities.map((cap) => {
    // A capability outside MODEL_SCOPES (e.g. `test`) never calls a model → no token cost.
    if (!(MODEL_SCOPES as readonly string[]).includes(cap)) {
      return { capability: cap, model: "—", inputTokens: 0, outputTokens: 0, costUsd: 0, basis: "default" as const };
    }
    const model = resolveModel(policy, cap as ModelScope) || DEFAULT_MODEL;
    const avg = averages.get(cap);
    let inputTokens: number;
    let outputTokens: number;
    let basis: "history" | "default";
    if (avg && avg.events >= MIN_SAMPLES) {
      inputTokens = Math.round(avg.inputTokens / avg.events);
      outputTokens = Math.round(avg.outputTokens / avg.events);
      basis = "history";
    } else {
      const d = DEFAULTS[cap] ?? FALLBACK;
      inputTokens = d.inputTokens;
      outputTokens = d.outputTokens;
      basis = "default";
    }
    return { capability: cap, model, inputTokens, outputTokens, costUsd: round(costUsd(model, inputTokens, outputTokens)), basis };
  });

  return {
    perStep,
    totalInputTokens: perStep.reduce((s, x) => s + x.inputTokens, 0),
    totalOutputTokens: perStep.reduce((s, x) => s + x.outputTokens, 0),
    totalCostUsd: round(perStep.reduce((s, x) => s + x.costUsd, 0)),
  };
}
