import { defineConfig } from "vitest/config";

// Vitest for @bureau/mind — the vault is exercised against a real temp directory.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
