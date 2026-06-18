import { describe, it, expect } from "vitest";

import { estimateTaskCost, type ScopeAverage } from "../src/estimate.js";
import { defaultModelPolicy } from "../src/models.js";

const policy = defaultModelPolicy(); // every scope on the default Opus model ($5 in / $25 out per 1M)

describe("estimateTaskCost", () => {
  it("uses the per-capability default when there's no history, and resolves the scope's model", () => {
    const est = estimateTaskCost(["edit"], policy, new Map());
    expect(est.perStep).toHaveLength(1);
    const s = est.perStep[0]!;
    expect(s.capability).toBe("edit");
    expect(s.basis).toBe("default");
    expect(s.model).toContain("opus");
    expect(s.inputTokens).toBe(24_000);
    expect(s.outputTokens).toBe(6_000);
    // 24000*5 + 6000*25 = 270000 micro-$ = $0.27
    expect(s.costUsd).toBeCloseTo(0.27, 6);
    expect(est.totalCostUsd).toBeCloseTo(0.27, 6);
  });

  it("uses the historical average once a scope has ≥ 3 samples", () => {
    const avg: ScopeAverage = { inputTokens: 100_000, outputTokens: 20_000, events: 5 }; // mean 20k / 4k
    const est = estimateTaskCost(["edit"], policy, new Map([["edit", avg]]));
    const s = est.perStep[0]!;
    expect(s.basis).toBe("history");
    expect(s.inputTokens).toBe(20_000);
    expect(s.outputTokens).toBe(4_000);
  });

  it("ignores a sparse history (< 3 samples) and falls back to the default", () => {
    const avg: ScopeAverage = { inputTokens: 99_000, outputTokens: 9_000, events: 2 };
    const est = estimateTaskCost(["edit"], policy, new Map([["edit", avg]]));
    expect(est.perStep[0]!.basis).toBe("default");
    expect(est.perStep[0]!.inputTokens).toBe(24_000); // not the sparse average
  });

  it("treats a non-model capability (test runs the suite) as zero cost", () => {
    const est = estimateTaskCost(["test"], policy, new Map());
    const s = est.perStep[0]!;
    expect(s.model).toBe("—");
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(0);
    expect(s.costUsd).toBe(0);
  });

  it("sums a multi-step pipeline (edit + test), test contributing nothing", () => {
    const est = estimateTaskCost(["edit", "test"], policy, new Map());
    expect(est.perStep.map((p) => p.capability)).toEqual(["edit", "test"]);
    expect(est.totalInputTokens).toBe(24_000);
    expect(est.totalCostUsd).toBeCloseTo(0.27, 6);
  });
});
