import { describe, it, expect, beforeEach } from "vitest";

import { createDb, runMigrations, type BureauDb } from "../src/client.js";
import { UsageRepo, type UsageRow } from "../src/usage-repo.js";

let db: BureauDb;
let repo: UsageRepo;

beforeEach(() => {
  db = createDb(":memory:");
  runMigrations(db);
  repo = new UsageRepo(db);
});

const u = (over: Partial<UsageRow> = {}): UsageRow => ({
  id: "u1",
  day: "2026-06-14",
  scope: "iris",
  taskId: null,
  model: "claude-opus-4-8",
  inputTokens: 100,
  outputTokens: 50,
  createdAt: "2026-06-14T00:00:00.000Z",
  ...over,
});

describe("UsageRepo", () => {
  it("records events and reads them back newest-first", () => {
    repo.record(u({ id: "a", createdAt: "2026-06-14T00:00:01.000Z" }));
    repo.record(u({ id: "b", createdAt: "2026-06-14T00:00:03.000Z" }));
    expect(repo.all().map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("is idempotent on a duplicate id", () => {
    repo.record(u({ id: "a", inputTokens: 100 }));
    repo.record(u({ id: "a", inputTokens: 999 }));
    expect(repo.all()).toHaveLength(1);
    expect(repo.all()[0]!.inputTokens).toBe(100);
  });

  it("since(day) filters by day inclusive", () => {
    repo.record(u({ id: "old", day: "2026-06-10" }));
    repo.record(u({ id: "mid", day: "2026-06-14" }));
    repo.record(u({ id: "new", day: "2026-06-20" }));
    expect(repo.since("2026-06-14").map((r) => r.id).sort()).toEqual(["mid", "new"]);
    expect(repo.since().map((r) => r.id).sort()).toEqual(["mid", "new", "old"]);
  });
});
