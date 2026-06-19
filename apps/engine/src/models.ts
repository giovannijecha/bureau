// Model policy — which model each scope (Iris chat + each worker capability) runs on.
// The model is a plain string threaded to the provider via SendOptions.model; this is
// the ONLY place the per-scope mapping lives, so capabilities never import a model
// constant (golden rule). Default: every scope on the current Opus model — NO behavior
// change until the CEO opts a scope onto a cheaper model (env or the Settings UI), e.g.
// chat → Sonnet to cut cost. Cost is already surfaced on the Metrics page (usage.ts).

import type { CapabilityKind } from "@bureau/core";
import { DEFAULT_MODEL } from "@bureau/providers";

export type ModelScope = "iris" | CapabilityKind;

/** Models the CEO may select — kept in sync with usage.ts's prefix-matched price table
 *  so a chosen model always prices, and recognized by the claude CLI's --model. */
export const KNOWN_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"] as const;

export function isKnownModel(m: string): boolean {
  return (KNOWN_MODELS as readonly string[]).includes(m);
}

/** Scopes that actually make a provider call (the `test` worker runs the suite, no model). */
export const MODEL_SCOPES: readonly ModelScope[] = ["iris", "plan", "research", "edit", "review", "document"];

export type ModelPolicy = Record<string, string>;

/** Safe default: every scope on the current Opus model. */
export function defaultModelPolicy(): ModelPolicy {
  const p: ModelPolicy = {};
  for (const s of MODEL_SCOPES) p[s] = DEFAULT_MODEL;
  return p;
}

/** Build the policy from optional per-scope env overrides (BUREAU_MODEL_IRIS, …),
 *  ignoring any unknown model id so a typo can't select an unpriced/unsupported model. */
export function modelPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ModelPolicy {
  const p = defaultModelPolicy();
  for (const s of MODEL_SCOPES) {
    const v = env[`BUREAU_MODEL_${s.toUpperCase()}`];
    if (v && isKnownModel(v)) p[s] = v;
  }
  return p;
}

/** The model for a scope, falling back to the Opus default for an unset/unknown scope. */
export function resolveModel(policy: ModelPolicy, scope: ModelScope): string {
  return policy[scope] ?? DEFAULT_MODEL;
}

// ── Reasoning effort ─────────────────────────────────────────────────────────
// A SECOND per-scope dial, parallel to the model policy: how hard a scope reasons.
// Native on both provider paths — the claude CLI's --effort and the Anthropic API's
// output_config.effort take the SAME vocabulary, so one value maps 1:1 to both. Unlike
// the model policy (which defaults to Opus), the effort policy defaults to EMPTY: an
// unset scope rides the model's built-in default effort, so there's zero behavior change
// until the CEO opts a scope onto a level. ("max" exists in the CLI/SDK but is left out
// of the selectable set — uncapped spend; widening to it later is a one-line change.)

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isKnownEffort(e: string): e is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(e);
}

export type EffortPolicy = Record<string, Effort>;

/** Default: empty — every scope on the model's built-in effort (no behavior change). */
export function defaultEffortPolicy(): EffortPolicy {
  return {};
}

/** Per-scope effort from optional env overrides (BUREAU_EFFORT_IRIS, …), ignoring any
 *  unknown level so a typo can't select an unsupported effort. */
export function effortPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): EffortPolicy {
  const p: EffortPolicy = {};
  for (const s of MODEL_SCOPES) {
    const v = env[`BUREAU_EFFORT_${s.toUpperCase()}`];
    if (v && isKnownEffort(v)) p[s] = v;
  }
  return p;
}

/** The effort for a scope, or undefined when unset — the caller then OMITS the field so
 *  the provider applies the model's default effort. */
export function resolveEffort(policy: EffortPolicy, scope: ModelScope): Effort | undefined {
  return policy[scope];
}
