import { describe, it, expect, vi } from "vitest";

import { withRetry } from "../src/retry.js";
import { ProviderError } from "../src/errors.js";

const noSleep = async (): Promise<void> => {}; // instant — no real backoff waits

describe("withRetry", () => {
  it("returns on the first success (one call)", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable error, then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ < 2) throw new ProviderError("blip", { kind: "transient" });
      return "ok";
    });
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after `retries` attempts and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("always", { kind: "transient" });
    });
    await expect(withRetry(fn, { retries: 2, sleep: noSleep })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("never retries a non-retryable error (one call)", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("refused", { kind: "refusal" });
    });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("refused");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors a custom isRetryable predicate", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ < 1) throw new Error("plain");
      return "ok";
    });
    expect(await withRetry(fn, { sleep: noSleep, isRetryable: () => true })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
