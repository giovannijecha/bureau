// CapabilityRegistry — register and resolve capabilities by kind.
// Phase 1: only `edit` implemented. plan/test/review/document are stubs.

import type { CapabilityKind } from "@bureau/core";
import type { Capability } from "./capability.js";

export class CapabilityRegistry {
  private readonly capabilities = new Map<CapabilityKind, Capability>();

  register(capability: Capability): void {
    this.capabilities.set(capability.kind, capability);
  }

  get(kind: CapabilityKind): Capability {
    const cap = this.capabilities.get(kind);
    if (!cap) {
      throw new Error(`Capability "${kind}" is not registered. Register it before use.`);
    }
    return cap;
  }

  has(kind: CapabilityKind): boolean {
    return this.capabilities.has(kind);
  }

  list(): CapabilityKind[] {
    return [...this.capabilities.keys()];
  }
}
