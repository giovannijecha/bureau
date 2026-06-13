// API-key auth strategy. Holds a key RESOLVER, never the plaintext key itself —
// the engine wires this to a secret_ref lookup so the DB never stores plaintext.

import type { AuthStrategy } from "../provider.js";

export class ApiKeyStrategy implements AuthStrategy {
  readonly kind = "api-key" as const;

  constructor(private readonly resolve: () => string | undefined) {}

  /** Available when the resolver yields a non-empty key. Never throws. */
  isAvailable(): boolean {
    const key = this.resolve();
    return typeof key === "string" && key.trim().length > 0;
  }

  /** Resolve the key for building an SDK client. Throws if unavailable. */
  apiKey(): string {
    const key = this.resolve();
    if (key === undefined || key.trim().length === 0) {
      throw new Error("ApiKeyStrategy: no API key resolved (secret_ref missing or empty).");
    }
    return key;
  }

  /** Convenience for local/dev: resolve from an environment variable. */
  static fromEnv(varName = "ANTHROPIC_API_KEY"): ApiKeyStrategy {
    return new ApiKeyStrategy(() => process.env[varName]);
  }
}
