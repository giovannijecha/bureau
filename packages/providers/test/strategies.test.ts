import { describe, it, expect } from "vitest";

import { ApiKeyStrategy } from "../src/strategies/api-key.js";
import { CliDelegationStrategy } from "../src/strategies/cli-delegation.js";

describe("ApiKeyStrategy", () => {
  it("kind is api-key", () => {
    expect(new ApiKeyStrategy(() => "k").kind).toBe("api-key");
  });

  it("isAvailable reflects whether the resolver yields a non-empty key", () => {
    expect(new ApiKeyStrategy(() => "sk-123").isAvailable()).toBe(true);
    expect(new ApiKeyStrategy(() => undefined).isAvailable()).toBe(false);
    expect(new ApiKeyStrategy(() => "").isAvailable()).toBe(false);
    expect(new ApiKeyStrategy(() => "   ").isAvailable()).toBe(false);
  });

  it("apiKey() returns the key or throws when unavailable", () => {
    expect(new ApiKeyStrategy(() => "sk-123").apiKey()).toBe("sk-123");
    expect(() => new ApiKeyStrategy(() => undefined).apiKey()).toThrow(/no API key/);
    expect(() => new ApiKeyStrategy(() => "  ").apiKey()).toThrow(/no API key/);
  });

  it("fromEnv reads the named environment variable", () => {
    process.env.BUREAU_TEST_KEY = "from-env";
    try {
      const s = ApiKeyStrategy.fromEnv("BUREAU_TEST_KEY");
      expect(s.isAvailable()).toBe(true);
      expect(s.apiKey()).toBe("from-env");
    } finally {
      delete process.env.BUREAU_TEST_KEY;
    }
    expect(ApiKeyStrategy.fromEnv("BUREAU_TEST_KEY_MISSING").isAvailable()).toBe(false);
  });
});

describe("CliDelegationStrategy", () => {
  it("kind is cli-delegation and cliCommand reflects the configured binary", () => {
    const s = new CliDelegationStrategy("claude");
    expect(s.kind).toBe("cli-delegation");
    expect(s.cliCommand()).toBe("claude");
  });

  it("isAvailable delegates to the injected probe and passes the cli name", () => {
    const seen: string[] = [];
    const present = new CliDelegationStrategy("claude", (cli) => {
      seen.push(cli);
      return true;
    });
    const absent = new CliDelegationStrategy("nope", () => false);

    expect(present.isAvailable()).toBe(true);
    expect(absent.isAvailable()).toBe(false);
    expect(seen).toEqual(["claude"]);
  });
});
