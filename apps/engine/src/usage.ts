// Usage & Cost — pure aggregation over raw usage events. No I/O.
//
// Cost is estimated from the model's published price ($ per 1M tokens). The map is
// matched by prefix so dated/variant model ids still resolve; an unknown model
// costs $0 (tokens still counted) rather than guessing.

import type { UsageRow } from "@bureau/db";
import type { UsageSummary } from "@bureau/contracts";

interface Price {
  readonly inPerM: number;
  readonly outPerM: number;
}

// $ per 1M tokens (input / output). Keyed by model-id prefix, longest match wins.
const PRICES: ReadonlyArray<readonly [prefix: string, price: Price]> = [
  ["claude-opus", { inPerM: 5, outPerM: 25 }],
  ["claude-sonnet", { inPerM: 3, outPerM: 15 }],
  ["claude-haiku", { inPerM: 1, outPerM: 5 }],
  ["claude-fable", { inPerM: 10, outPerM: 50 }],
];

export function priceFor(model: string): Price {
  let best: Price = { inPerM: 0, outPerM: 0 };
  let bestLen = -1;
  for (const [prefix, price] of PRICES) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}

interface Bucket {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function add(b: Bucket, row: UsageRow): void {
  b.inputTokens += row.inputTokens;
  b.outputTokens += row.outputTokens;
  b.costUsd += costUsd(row.model, row.inputTokens, row.outputTokens);
}

function emptyBucket(): Bucket {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Round a USD figure to whole micro-dollars so the JSON stays tidy. */
function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Aggregate raw usage events into totals + per-scope / per-model / per-day breakdowns. */
export function summarizeUsage(rows: readonly UsageRow[], sinceDay: string | null): UsageSummary {
  const totals = emptyBucket();
  const byScope = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket>();
  const byDay = new Map<string, Bucket>();
  const bump = (m: Map<string, Bucket>, key: string, row: UsageRow) => {
    const b = m.get(key) ?? emptyBucket();
    add(b, row);
    m.set(key, b);
  };

  for (const row of rows) {
    add(totals, row);
    bump(byScope, row.scope, row);
    bump(byModel, row.model, row);
    bump(byDay, row.day, row);
  }

  const seal = <K extends string>(m: Map<string, Bucket>, key: K) =>
    [...m.entries()].map(([k, b]) => ({ [key]: k, inputTokens: b.inputTokens, outputTokens: b.outputTokens, costUsd: round(b.costUsd) }));

  return {
    totals: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costUsd: round(totals.costUsd), events: rows.length },
    byScope: (seal(byScope, "scope") as UsageSummary["byScope"]).sort((a, b) => b.costUsd - a.costUsd),
    byModel: (seal(byModel, "model") as UsageSummary["byModel"]).sort((a, b) => b.costUsd - a.costUsd),
    byDay: (seal(byDay, "day") as UsageSummary["byDay"]).sort((a, b) => (a.day < b.day ? -1 : 1)),
    sinceDay,
  };
}
