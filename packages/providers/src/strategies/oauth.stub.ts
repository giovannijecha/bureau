// OAuth auth strategy — STUB. isAvailable() always returns false.
// Confirmed simplification: no OAuth work until explicitly requested by the user.

import type { AuthStrategy } from "../provider.js";

export class OAuthStrategy implements AuthStrategy {
  readonly kind = "oauth" as const;
  isAvailable(): boolean {
    return false; // stub — not implemented
  }
}
