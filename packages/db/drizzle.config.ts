import { defineConfig } from "drizzle-kit";

// Codegen only — `pnpm --filter @bureau/db db:generate` writes SQL to ./drizzle.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
});
