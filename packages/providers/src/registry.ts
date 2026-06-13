// ProviderRegistry — register and retrieve active provider.
// Stubs: OAuthStrategy always returns isAvailable() = false (confirmed simplification).

import type { Provider } from "./provider.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();
  private activeKey: string | null = null;

  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  setActive(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" is not registered.`);
    }
    this.activeKey = name;
  }

  getActive(): Provider {
    if (!this.activeKey) throw new Error("No active provider set.");
    const p = this.providers.get(this.activeKey);
    if (!p) throw new Error(`Active provider "${this.activeKey}" disappeared.`);
    return p;
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}
