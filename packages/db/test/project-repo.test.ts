import { describe, it, expect, beforeEach } from "vitest";

import { createDb, runMigrations, type BureauDb } from "../src/client.js";
import { ProjectRepo, type ProjectRow } from "../src/project-repo.js";

let db: BureauDb;
let repo: ProjectRepo;

beforeEach(() => {
  db = createDb(":memory:");
  runMigrations(db);
  repo = new ProjectRepo(db);
});

const p = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: "acme-widget",
  owner: "acme",
  name: "widget",
  url: "https://github.com/acme/widget",
  baseBranch: "main",
  testCommand: null,
  createdAt: "2026-06-18T00:00:00.000Z",
  ...over,
});

describe("ProjectRepo", () => {
  it("seed is idempotent — double-seeding keeps one row (first-run env seed)", () => {
    repo.seed(p());
    repo.seed(p({ url: "https://github.com/acme/CHANGED" })); // same id → no-op
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe("https://github.com/acme/widget"); // original kept
  });

  it("upsert inserts then overwrites the durable facts (CEO add / re-add)", () => {
    repo.upsert(p());
    repo.upsert(p({ baseBranch: "develop", testCommand: ["npm", "test"] }));
    const row = repo.get("acme-widget");
    expect(row?.baseBranch).toBe("develop");
    expect(row?.testCommand).toEqual(["npm", "test"]); // JSON column round-trips
  });

  it("lists in insertion order and deletes by id", () => {
    repo.seed(p({ id: "a", createdAt: "2026-06-18T00:00:00.000Z" }));
    repo.seed(p({ id: "b", createdAt: "2026-06-18T00:00:01.000Z" }));
    expect(repo.list().map((r) => r.id)).toEqual(["a", "b"]);
    repo.delete("a");
    expect(repo.list().map((r) => r.id)).toEqual(["b"]);
    expect(repo.get("a")).toBeNull();
  });
});
