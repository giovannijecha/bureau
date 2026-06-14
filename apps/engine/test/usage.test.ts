import { describe, it, expect } from "vitest";
import type { UsageRow } from "@bureau/db";
import { costUsd, priceFor, summarizeUsage } from "../src/usage.js";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  id: "u1",
  day: "2026-06-14",
  scope: "iris",
  taskId: null,
  model: "claude-opus-4-8",
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  createdAt: "2026-06-14T00:00:00.000Z",
  ...over,
});

describe("cost", () => {
  it("prices Opus at $5/$25 per Mtok", () => {
    expect(priceFor("claude-opus-4-8")).toEqual({ inPerM: 5, outPerM: 25 });
    expect(costUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
  });

  it("matches by prefix and falls back to $0 for an unknown model (tokens still counted)", () => {
    expect(priceFor("claude-sonnet-4-6")).toEqual({ inPerM: 3, outPerM: 15 });
    expect(costUsd("some-future-model", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("summarizeUsage", () => {
  it("aggregates totals + per-scope / per-model / per-day", () => {
    const rows: UsageRow[] = [
      row({ id: "a", scope: "iris", model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 0, day: "2026-06-13" }),
      row({ id: "b", scope: "edit", model: "claude-opus-4-8", inputTokens: 0, outputTokens: 1_000_000, day: "2026-06-14" }),
      row({ id: "c", scope: "edit", model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0, day: "2026-06-14" }),
    ];
    const s = summarizeUsage(rows, null);

    expect(s.totals.events).toBe(3);
    expect(s.totals.inputTokens).toBe(2_000_000);
    expect(s.totals.outputTokens).toBe(1_000_000);
    // opus: $5 (1M in) + $25 (1M out) = $30; haiku: $1 (1M in) = $1 → $31 total
    expect(s.totals.costUsd).toBeCloseTo(31, 6);

    expect(s.byScope.find((x) => x.scope === "edit")!.inputTokens).toBe(1_000_000);
    expect(s.byScope.find((x) => x.scope === "edit")!.outputTokens).toBe(1_000_000);
    // byDay is chronological
    expect(s.byDay.map((d) => d.day)).toEqual(["2026-06-13", "2026-06-14"]);
    // byModel/byScope sorted by cost desc
    expect(s.byModel[0]!.model).toBe("claude-opus-4-8");
  });

  it("passes sinceDay through", () => {
    expect(summarizeUsage([], "2026-06-01").sinceDay).toBe("2026-06-01");
  });
});
