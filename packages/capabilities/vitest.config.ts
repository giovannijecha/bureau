import { defineConfig } from "vitest/config";

// Vitest for @bureau/capabilities — the edit worker is exercised with a fake
// Provider and an injected file-writer (no network, no real disk writes needed).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/edit.ts", "src/registry.ts"],
    },
  },
});
