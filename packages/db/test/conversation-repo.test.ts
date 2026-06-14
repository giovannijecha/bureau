import { describe, it, expect, beforeEach } from "vitest";

import { createDb, runMigrations, type BureauDb } from "../src/client.js";
import { ConversationRepo, type ConversationRow } from "../src/conversation-repo.js";
import { MessageRepo } from "../src/message-repo.js";

let db: BureauDb;
let repo: ConversationRepo;
let msgs: MessageRepo;

beforeEach(() => {
  db = createDb(":memory:");
  runMigrations(db);
  repo = new ConversationRepo(db);
  msgs = new MessageRepo(db);
});

const c = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  id: "c1",
  title: "New chat",
  projectId: null,
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
  ...over,
});

describe("ConversationRepo", () => {
  it("creates, reads, and lists most-recently-active first", () => {
    repo.create(c({ id: "a", updatedAt: "2026-06-14T00:00:01.000Z" }));
    repo.create(c({ id: "b", updatedAt: "2026-06-14T00:00:03.000Z" }));
    repo.create(c({ id: "x", updatedAt: "2026-06-14T00:00:02.000Z" }));

    expect(repo.get("a")?.title).toBe("New chat");
    expect(repo.list().map((r) => r.id)).toEqual(["b", "x", "a"]); // updatedAt desc
  });

  it("rename and touch update the right fields", () => {
    repo.create(c({ id: "a" }));
    repo.rename("a", "My thread", "2026-06-14T01:00:00.000Z");
    expect(repo.get("a")).toMatchObject({ title: "My thread", updatedAt: "2026-06-14T01:00:00.000Z" });
    repo.touch("a", "2026-06-14T02:00:00.000Z");
    expect(repo.get("a")?.updatedAt).toBe("2026-06-14T02:00:00.000Z");
  });

  it("delete removes the conversation AND its messages, leaving others intact", () => {
    repo.create(c({ id: "a" }));
    repo.create(c({ id: "b" }));
    msgs.append({ id: "m1", conversationId: "a", role: "user", content: "hi", taskId: null, createdAt: "t" });
    msgs.append({ id: "m2", conversationId: "b", role: "user", content: "other", taskId: null, createdAt: "t" });

    repo.delete("a");

    expect(repo.get("a")).toBeNull();
    expect(msgs.listByConversation("a")).toHaveLength(0);
    expect(repo.get("b")).not.toBeNull();
    expect(msgs.listByConversation("b")).toHaveLength(1);
  });

  it("create is idempotent on id (re-create keeps the first)", () => {
    repo.create(c({ id: "a", title: "first" }));
    repo.create(c({ id: "a", title: "second" }));
    expect(repo.list()).toHaveLength(1);
    expect(repo.get("a")?.title).toBe("first");
  });
});
