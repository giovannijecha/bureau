// ProjectRepo — persistence for the repositories Bureau works on. Owns its own row
// shape (no contracts import — db imports @bureau/core only). On-disk paths are NOT
// stored; the engine re-derives them from BUREAU_REPOS_ROOT + id at boot.

import { eq } from "drizzle-orm";
import type { BureauDb } from "./client.js";
import { projects } from "./schema.js";

export interface ProjectRow {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly url: string;
  readonly baseBranch: string;
  readonly testCommand: string[] | null;
  /** The verify loop's full check list (list of argv commands). NULL ⇒ fall back to testCommand. */
  readonly verifyCommands: string[][] | null;
  /** Dependency-install override (argv). NULL ⇒ auto-detect the stack. */
  readonly provisionCommand: string[] | null;
  readonly createdAt: string;
}

const toRow = (r: typeof projects.$inferSelect): ProjectRow => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  url: r.url,
  baseBranch: r.baseBranch,
  testCommand: r.testCommand ?? null,
  verifyCommands: r.verifyCommands ?? null,
  provisionCommand: r.provisionCommand ?? null,
  createdAt: r.createdAt,
});

export class ProjectRepo {
  constructor(private readonly db: BureauDb) {}

  /** Idempotent first-run seed (from BUREAU_PROJECTS): insert only if absent. */
  seed(row: ProjectRow): void {
    this.db.insert(projects).values({ ...row }).onConflictDoNothing({ target: projects.id }).run();
  }

  /** CEO add: insert, or overwrite the durable facts if the id already exists. */
  upsert(row: ProjectRow): void {
    this.db
      .insert(projects)
      .values({ ...row })
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          owner: row.owner,
          name: row.name,
          url: row.url,
          baseBranch: row.baseBranch,
          testCommand: row.testCommand,
          verifyCommands: row.verifyCommands,
          provisionCommand: row.provisionCommand,
        },
      })
      .run();
  }

  get(id: string): ProjectRow | null {
    const r = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return r ? toRow(r) : null;
  }

  /** All projects, insertion order (createdAt) — env-seeded first, then CEO-added. */
  list(): ProjectRow[] {
    return this.db.select().from(projects).orderBy(projects.createdAt).all().map(toRow);
  }

  delete(id: string): void {
    this.db.delete(projects).where(eq(projects.id, id)).run();
  }
}
