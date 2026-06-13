import { defineConfig } from "vitest/config";

// Vitest for @bureau/providers — adapters are exercised with injected fakes
// (a fake SDK client, a fake CLI runner); no network or CLI is touched.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Stub + barrel files have no behavior worth covering.
      exclude: ["src/index.ts", "src/provider.ts", "src/strategies/oauth.stub.ts"],
    },
  },
});
