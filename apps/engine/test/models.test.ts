import { describe, it, expect } from "vitest";
import { defaultModelPolicy, modelPolicyFromEnv, resolveModel, isKnownModel, KNOWN_MODELS, MODEL_SCOPES } from "../src/models.js";
import { priceFor } from "../src/usage.js";

describe("model policy", () => {
  it("defaults every scope to the Opus model (no behavior change)", () => {
    const p = defaultModelPolicy();
    for (const s of MODEL_SCOPES) expect(p[s]).toBe("claude-opus-4-8");
  });

  it("resolveModel returns the scope's model, falling back to Opus for an unknown scope", () => {
    const p = defaultModelPolicy();
    p.iris = "claude-sonnet-4-6";
    expect(resolveModel(p, "iris")).toBe("claude-sonnet-4-6");
    expect(resolveModel(p, "edit")).toBe("claude-opus-4-8");
    expect(resolveModel({}, "iris")).toBe("claude-opus-4-8"); // empty policy → default
  });

  it("isKnownModel accepts the supported ids and rejects others", () => {
    for (const m of KNOWN_MODELS) expect(isKnownModel(m)).toBe(true);
    expect(isKnownModel("gpt-4")).toBe(false);
    expect(isKnownModel("claude-opus-4-8-20990101")).toBe(false); // exact-match only
  });

  it("modelPolicyFromEnv applies known overrides and ignores unknown/typo ids", () => {
    const p = modelPolicyFromEnv({ BUREAU_MODEL_IRIS: "claude-sonnet-4-6", BUREAU_MODEL_EDIT: "not-a-model" });
    expect(p.iris).toBe("claude-sonnet-4-6"); // applied
    expect(p.edit).toBe("claude-opus-4-8"); // bad id ignored → default
  });

  it("every selectable model has a price (no selectable-but-unpriced drift)", () => {
    for (const m of KNOWN_MODELS) {
      const price = priceFor(m);
      expect(price.inPerM).toBeGreaterThan(0);
      expect(price.outPerM).toBeGreaterThan(0);
    }
  });
});
