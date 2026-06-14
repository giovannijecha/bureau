// ConversationRepo — persistence for ChatGPT-style chat threads. Owns its own row
// shape (no contracts import — db imports @bureau/core only). Deleting a
// conversation deletes its messages.

import { eq, desc } from "drizzle-orm";
import type { BureauDb } from "./client.js";
import { conversations, messages } from "./schema.js";

export interface ConversationRow {
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const toRow = (r: typeof conversations.$inferSelect): ConversationRow => ({
  id: r.id,
  title: r.title,
  projectId: r.projectId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class ConversationRepo {
  constructor(private readonly db: BureauDb) {}

  create(row: ConversationRow): void {
    this.db.insert(conversations).values({ ...row }).onConflictDoNothing({ target: conversations.id }).run();
  }

  get(id: string): ConversationRow | null {
    const r = this.db.select().from(conversations).where(eq(conversations.id, id)).get();
    return r ? toRow(r) : null;
  }

  /** Conversations, most-recently-active first. */
  list(): ConversationRow[] {
    return this.db.select().from(conversations).orderBy(desc(conversations.updatedAt), desc(conversations.createdAt)).all().map(toRow);
  }

  rename(id: string, title: string, updatedAt: string): void {
    this.db.update(conversations).set({ title, updatedAt }).where(eq(conversations.id, id)).run();
  }

  /** Bump updatedAt so the conversation floats to the top of the list. */
  touch(id: string, updatedAt: string): void {
    this.db.update(conversations).set({ updatedAt }).where(eq(conversations.id, id)).run();
  }

  delete(id: string): void {
    this.db.delete(messages).where(eq(messages.conversationId, id)).run();
    this.db.delete(conversations).where(eq(conversations.id, id)).run();
  }
}
