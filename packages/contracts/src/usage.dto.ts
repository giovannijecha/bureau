import { z } from "zod";

// Usage & Cost metrics — token spend across Iris and the capability workers.
// Every provider round-trip records input/output tokens; the engine aggregates
// them into totals, per-scope, per-model, and a per-day time series, with a USD
// cost estimate from the model's price.

const Tokens = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export const UsageScopeStatDto = Tokens.extend({ scope: z.string(), events: z.number().int().nonnegative() });
export const UsageModelStatDto = Tokens.extend({ model: z.string() });
export const UsageDayStatDto = Tokens.extend({ day: z.string() });

export const UsageSummaryDto = z.object({
  totals: Tokens.extend({ events: z.number().int().nonnegative() }),
  byScope: z.array(UsageScopeStatDto),
  byModel: z.array(UsageModelStatDto),
  byDay: z.array(UsageDayStatDto),
  /** The look-back window's first day (UTC), or null for all-time. */
  sinceDay: z.string().nullable(),
});

export type UsageScopeStat = z.infer<typeof UsageScopeStatDto>;
export type UsageModelStat = z.infer<typeof UsageModelStatDto>;
export type UsageDayStat = z.infer<typeof UsageDayStatDto>;
export type UsageSummary = z.infer<typeof UsageSummaryDto>;

// ── Pre-run cost estimate ────────────────────────────────────────────────────
// Before the CEO creates a task, estimate its token spend + USD cost — per step
// (capability), from that scope's historical average where we have data, else a
// sensible default. A rough forecast, clearly labelled, not a quote.

export const CostStepDto = z.object({
  capability: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** "history" when this scope's average was used; "default" when we had no data yet. */
  basis: z.enum(["history", "default"]),
});

export const CostEstimateDto = z.object({
  perStep: z.array(CostStepDto),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
});

export const EstimateRequestDto = z.object({
  capabilities: z.array(z.string().min(1)).nonempty().max(20),
});

export type CostStep = z.infer<typeof CostStepDto>;
export type CostEstimate = z.infer<typeof CostEstimateDto>;
export type EstimateRequest = z.infer<typeof EstimateRequestDto>;
