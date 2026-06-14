// UsageRepo — append-only token-usage events for the Usage & Cost metrics.
// Owns its own row shape (db imports @bureau/core only). Aggregation (cost,
// per-scope, per-day) is computed in the engine from the raw events.

import { gte, desc } from "drizzle-orm";
import type { BureauDb } from "./client.js";
import { usageEvents } from "./schema.js";

export interface UsageRow {
  readonly id: string;
  readonly day: string;
  readonly scope: string;
  readonly taskId: string | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

const toRow = (r: typeof usageEvents.$inferSelect): UsageRow => ({
  id: r.id,
  day: r.day,
  scope: r.scope,
  taskId: r.taskId,
  model: r.model,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  createdAt: r.createdAt,
});

export class UsageRepo {
  constructor(private readonly db: BureauDb) {}

  /** Record one provider round-trip's spend. */
  record(row: UsageRow): void {
    this.db.insert(usageEvents).values({ ...row }).onConflictDoNothing({ target: usageEvents.id }).run();
  }

  /** Events on or after `sinceDay` (UTC YYYY-MM-DD), newest first. Omit for all. */
  since(sinceDay?: string): UsageRow[] {
    const q = this.db.select().from(usageEvents);
    const rows = sinceDay ? q.where(gte(usageEvents.day, sinceDay)).all() : q.all();
    return rows.map(toRow).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Convenience: every event, newest first. */
  all(): UsageRow[] {
    return this.db.select().from(usageEvents).orderBy(desc(usageEvents.createdAt)).all().map(toRow);
  }
}
