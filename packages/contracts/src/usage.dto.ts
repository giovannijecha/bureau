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

export const UsageScopeStatDto = Tokens.extend({ scope: z.string() });
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
