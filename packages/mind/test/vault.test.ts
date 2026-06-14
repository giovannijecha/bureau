import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readNote, writeNote, listNotes, noteModifiedAt, VaultError } from "../src/vault.js";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "bureau-vault-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("vault read/write", () => {
  it("writes a note, creating parent folders, then reads it back", async () => {
    await writeNote(vault, "journals/2026-06-14-task.md", "# Task\n\nbody");
    expect(await readNote(vault, "journals/2026-06-14-task.md")).toBe("# Task\n\nbody");
  });

  it("overwrites an existing note (journals are idempotent by path)", async () => {
    await writeNote(vault, "notes/x.md", "v1");
    await writeNote(vault, "notes/x.md", "v2");
    expect(await readNote(vault, "notes/x.md")).toBe("v2");
  });

  it("noteModifiedAt returns an ISO timestamp for a written note, null for a missing one", async () => {
    await writeNote(vault, "notes/x.md", "hi");
    expect(await noteModifiedAt(vault, "notes/x.md")).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await noteModifiedAt(vault, "notes/missing.md")).toBeNull();
  });
});

describe("listNotes", () => {
  it("returns every .md recursively as sorted POSIX paths, ignoring non-md files", async () => {
    await writeNote(vault, "notes/b.md", "b");
    await writeNote(vault, "notes/a.md", "a");
    await writeNote(vault, "journals/j.md", "j");
    await writeNote(vault, "notes/keep.txt", "not a note");
    expect(await listNotes(vault)).toEqual(["journals/j.md", "notes/a.md", "notes/b.md"]);
  });

  it("returns [] for a vault dir that doesn't exist yet", async () => {
    expect(await listNotes(join(vault, "nope"))).toEqual([]);
  });
});

describe("path safety", () => {
  it("refuses to escape the vault with ..", async () => {
    await expect(writeNote(vault, "../escape.md", "x")).rejects.toBeInstanceOf(VaultError);
    await expect(readNote(vault, "../../etc/passwd")).rejects.toThrow(/stay within the vault|outside the vault/);
  });

  it("refuses an absolute note path", async () => {
    await expect(writeNote(vault, "/etc/evil.md", "x")).rejects.toBeInstanceOf(VaultError);
  });
});
