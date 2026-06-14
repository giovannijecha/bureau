import { describe, it, expect, beforeEach } from "vitest";

import { createDb, runMigrations, type BureauDb } from "../src/client.js";
import { NotificationRepo, type NotificationRow } from "../src/notification-repo.js";

let db: BureauDb;
let repo: NotificationRepo;

beforeEach(() => {
  db = createDb(":memory:");
  runMigrations(db);
  repo = new NotificationRepo(db);
});

const n = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "n1",
  kind: "review",
  taskId: "t1",
  subject: "Ready for your review",
  body: "…",
  createdAt: "2026-06-14T00:00:00.000Z",
  readAt: null,
  ...over,
});

describe("NotificationRepo", () => {
  it("creates, lists newest-first, and counts unread", () => {
    repo.create(n({ id: "a", createdAt: "2026-06-14T00:00:01.000Z" }));
    repo.create(n({ id: "b", createdAt: "2026-06-14T00:00:03.000Z" }));
    expect(repo.list().map((r) => r.id)).toEqual(["b", "a"]);
    expect(repo.unreadCount()).toBe(2);
  });

  it("marks one read and all read", () => {
    repo.create(n({ id: "a" }));
    repo.create(n({ id: "b" }));
    repo.markRead("a", "2026-06-14T01:00:00.000Z");
    expect(repo.unreadCount()).toBe(1);
    repo.markAllRead("2026-06-14T02:00:00.000Z");
    expect(repo.unreadCount()).toBe(0);
  });

  it("is idempotent on a duplicate id", () => {
    repo.create(n({ id: "a", subject: "first" }));
    repo.create(n({ id: "a", subject: "second" }));
    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0]!.subject).toBe("first");
  });
});
