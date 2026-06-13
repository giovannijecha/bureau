// MessageRepo — persistence for the CEO ↔ Iris chat log. A flat, append-only
// stream ordered by an autoincrement `seq`, so it reads back exactly as written.
//
// The repo owns its own row shape (MessageRow) rather than importing the Message
// DTO from @bureau/contracts — db imports @bureau/core ONLY (golden rule). The
// engine adapter maps MessageRow ↔ Message (null ↔ undefined for taskId).

import { asc } from "drizzle-orm";
import type { BureauDb } from "./client.js";
import { messages } from "./schema.js";

export type MessageRole = "user" | "iris" | "system";

export interface MessageRow {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly taskId: string | null;
  readonly createdAt: string;
}

export class MessageRepo {
  constructor(private readonly db: BureauDb) {}

  /** Append a message. Idempotent on `id` (re-appending the same id is a no-op). */
  append(message: MessageRow): void {
    this.db
      .insert(messages)
      .values({
        id: message.id,
        role: message.role,
        content: message.content,
        taskId: message.taskId,
        createdAt: message.createdAt,
      })
      .onConflictDoNothing({ target: messages.id })
      .run();
  }

  /** The whole chat log, in insertion order. */
  list(): MessageRow[] {
    return this.db
      .select()
      .from(messages)
      .orderBy(asc(messages.seq))
      .all()
      .map((r) => ({ id: r.id, role: r.role, content: r.content, taskId: r.taskId, createdAt: r.createdAt }));
  }
}
