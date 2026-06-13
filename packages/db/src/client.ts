// SQLite client (better-sqlite3 sync — zero extra processes) + migration runner.

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { schema } from "./schema.js";

export type BureauDb = BetterSQLite3Database<typeof schema>;

// Generated SQL migrations live in <package>/drizzle, one level up from both
// dist/client.js (built) and src/client.ts (tests run the source via Vitest).
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Open a SQLite database and wrap it in Drizzle. Pass ":memory:" for an
 * ephemeral DB (tests). Foreign keys are enabled so child rows cascade on
 * delete; WAL is requested for on-disk databases.
 */
export function createDb(filename: string): BureauDb {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/** Apply all pending migrations from the package's drizzle/ folder. */
export function runMigrations(
  db: BureauDb,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER
): void {
  migrate(db, { migrationsFolder });
}
