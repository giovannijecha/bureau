import { defineConfig } from "vitest/config";

// Vitest for @bureau/core — pure domain, no I/O, runs in plain Node.
// Tests live in test/ and import the TypeScript source directly; Vite resolves
// the project's NodeNext ".js" import specifiers to their ".ts" siblings.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Type-only modules have no runtime to cover; the state machine is the target.
      exclude: ["src/index.ts", "src/task.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
