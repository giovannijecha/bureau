// NotificationRepo — durable CEO notifications. Owns its own row shape (db imports
// @bureau/core only). Newest-first; unread = read_at IS NULL.

import { eq, isNull, desc, sql } from "drizzle-orm";
import type { BureauDb } from "./client.js";
import { notifications } from "./schema.js";

export interface NotificationRow {
  readonly id: string;
  readonly kind: string;
  readonly taskId: string | null;
  readonly subject: string;
  readonly body: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

const toRow = (r: typeof notifications.$inferSelect): NotificationRow => ({
  id: r.id,
  kind: r.kind,
  taskId: r.taskId,
  subject: r.subject,
  body: r.body,
  createdAt: r.createdAt,
  readAt: r.readAt,
});

export class NotificationRepo {
  constructor(private readonly db: BureauDb) {}

  create(row: NotificationRow): void {
    this.db.insert(notifications).values({ ...row }).onConflictDoNothing({ target: notifications.id }).run();
  }

  /** Notifications, newest first, capped at `limit`. */
  list(limit = 50): NotificationRow[] {
    return this.db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit).all().map(toRow);
  }

  unreadCount(): number {
    const r = this.db.select({ n: sql<number>`count(*)` }).from(notifications).where(isNull(notifications.readAt)).get();
    return r?.n ?? 0;
  }

  markRead(id: string, readAt: string): void {
    this.db.update(notifications).set({ readAt }).where(eq(notifications.id, id)).run();
  }

  markAllRead(readAt: string): void {
    this.db.update(notifications).set({ readAt }).where(isNull(notifications.readAt)).run();
  }
}
