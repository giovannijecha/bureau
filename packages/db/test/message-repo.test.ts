import { describe, it, expect, beforeEach } from "vitest";

import { createDb, runMigrations, type BureauDb } from "../src/client.js";
import { MessageRepo, type MessageRow } from "../src/message-repo.js";

let db: BureauDb;
let repo: MessageRepo;

beforeEach(() => {
  db = createDb(":memory:");
  runMigrations(db);
  repo = new MessageRepo(db);
});

const m = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: "m1",
  role: "user",
  content: "hello",
  taskId: null,
  createdAt: "2026-06-13T00:00:00.000Z",
  ...over,
});

describe("MessageRepo", () => {
  it("returns an empty log initially", () => {
    expect(repo.list()).toEqual([]);
  });

  it("appends and reads back messages in insertion order, even on tied timestamps", () => {
    const ts = "2026-06-13T00:00:00.000Z";
    repo.append(m({ id: "a", role: "user", content: "hi", createdAt: ts }));
    repo.append(m({ id: "b", role: "iris", content: "hello", createdAt: ts })); // same millisecond
    repo.append(m({ id: "c", role: "system", content: "made a task", taskId: "t1", createdAt: "2026-06-13T00:00:01.000Z" }));

    const log = repo.list();
    expect(log.map((x) => x.id)).toEqual(["a", "b", "c"]); // seq preserves insertion order
    expect(log[1]).toMatchObject({ role: "iris", content: "hello", taskId: null });
    expect(log[2]).toMatchObject({ role: "system", taskId: "t1" });
  });

  it("is idempotent on id — re-appending the same id is ignored", () => {
    repo.append(m({ id: "x", content: "first" }));
    repo.append(m({ id: "x", content: "second" }));
    const log = repo.list();
    expect(log).toHaveLength(1);
    expect(log[0]!.content).toBe("first");
  });

  it("persists an absent taskId as null", () => {
    repo.append(m({ id: "n", taskId: null }));
    expect(repo.list()[0]!.taskId).toBeNull();
  });
});
