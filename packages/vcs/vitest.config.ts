import { defineConfig } from "vitest/config";

// Vitest for @bureau/vcs — git helpers are integration-tested against real git
// on temp repos; gh/push paths are unit-tested with a fake runner.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000, // real git spawns can be slow on Windows
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
