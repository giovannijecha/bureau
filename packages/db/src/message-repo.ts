// MessageRepo — persistence for the CEO ↔ Iris chat log, scoped to conversations.
// A flat, append-only stream ordered by an autoincrement `seq`, so it reads back
// exactly as written.
//
// The repo owns its own row shape (MessageRow) rather than importing the Message
// DTO from @bureau/contracts — db imports @bureau/core ONLY (golden rule). The
// engine adapter maps MessageRow ↔ Message (null ↔ undefined).

import { asc, eq, isNull } from "drizzle-orm";
import type { BureauDb } from "./client.js";
import { messages } from "./schema.js";

export type MessageRole = "user" | "iris" | "system";

export interface MessageRow {
  readonly id: string;
  readonly conversationId: string | null;
  readonly role: MessageRole;
  readonly content: string;
  readonly taskId: string | null;
  readonly createdAt: string;
}

const toRow = (r: typeof messages.$inferSelect): MessageRow => ({
  id: r.id,
  conversationId: r.conversationId,
  role: r.role,
  content: r.content,
  taskId: r.taskId,
  createdAt: r.createdAt,
});

export class MessageRepo {
  constructor(private readonly db: BureauDb) {}

  /** Append a message. Idempotent on `id` (re-appending the same id is a no-op). */
  append(message: MessageRow): void {
    this.db
      .insert(messages)
      .values({
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        taskId: message.taskId,
        createdAt: message.createdAt,
      })
      .onConflictDoNothing({ target: messages.id })
      .run();
  }

  /** Messages in one conversation, in insertion order. */
  listByConversation(conversationId: string): MessageRow[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.seq))
      .all()
      .map(toRow);
  }

  /** The whole chat log across all conversations, in insertion order. */
  list(): MessageRow[] {
    return this.db.select().from(messages).orderBy(asc(messages.seq)).all().map(toRow);
  }

  /** Assign every conversation-less message (from before threads existed) to a
   *  conversation. Returns how many were adopted. */
  adoptOrphans(conversationId: string): number {
    const orphans = this.db.select({ id: messages.id }).from(messages).where(isNull(messages.conversationId)).all();
    if (orphans.length === 0) return 0;
    this.db.update(messages).set({ conversationId }).where(isNull(messages.conversationId)).run();
    return orphans.length;
  }
}
