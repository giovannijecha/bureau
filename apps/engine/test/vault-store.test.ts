import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VaultStore } from "../src/adapters.js";

// Exercises the real VaultStore against a temp markdown vault — closes the loop
// between @bureau/mind (fs) and the engine's note metadata/journal helpers.

let dir: string;
let vault: VaultStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bureau-vaultstore-"));
  vault = new VaultStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("VaultStore", () => {
  it("saves a CEO note, lists it, and reads it back with parsed metadata", async () => {
    const saved = await vault.saveNote("Coding standards", "Always run `make quality` before merge.");
    expect(saved.path).toBe("notes/coding-standards.md");
    expect(saved.kind).toBe("note");
    expect(saved.title).toBe("Coding standards");
    expect(saved.body).toContain("# Coding standards");

    const list = await vault.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("Coding standards");
    expect(list[0]!.excerpt).toContain("make quality");

    const got = await vault.get("notes/coding-standards.md");
    expect(got?.body).toContain("make quality");
    expect(await vault.get("notes/missing.md")).toBeNull();
  });

  it("writes a journal that lists as kind 'journal' and is lexically searchable", async () => {
    await vault.writeJournal("journals/2026-06-14-add-quickstart-abc12345.md", "# Add a Quick Start\n\nMerged to main.");
    await vault.saveNote("Unrelated", "nothing here");

    const journals = await vault.list("quick start");
    expect(journals).toHaveLength(1);
    expect(journals[0]!.kind).toBe("journal");
    expect(journals[0]!.title).toBe("Add a Quick Start");
  });
});
