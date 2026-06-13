import { defineConfig } from "vitest/config";

// Vitest for @bureau/engine — the orchestrator (Iris) is driven with fake ports
// (in-memory store, fake VCS, fake provider), so the canPush security gate is
// verified with no DB, git, or network.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/orchestrator.ts", "src/summary.ts"],
    },
  },
});
