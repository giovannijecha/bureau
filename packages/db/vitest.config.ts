import { defineConfig } from "vitest/config";

// Vitest for @bureau/db — exercises the real better-sqlite3 driver against an
// in-memory database. Tests import the TypeScript source directly.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/mapper.ts", "src/repo.ts"],
    },
  },
});
