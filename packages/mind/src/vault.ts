// Obsidian-style vault adapter — a directory of markdown notes on disk.
// Pure filesystem; no other @bureau/* deps. The engine layers note metadata
// (title, kind, excerpt) and journaling on top of these primitives.

import { readFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Resolve a vault-relative note path to an absolute one, refusing anything that
 *  would escape the vault (absolute paths, `..` traversal). */
function resolveInVault(vaultPath: string, notePath: string): string {
  const cleaned = normalize(notePath).replace(/\\/g, "/");
  if (cleaned.startsWith("/") || cleaned === ".." || cleaned.startsWith("../") || cleaned.includes("/../")) {
    throw new VaultError(`Unsafe note path "${notePath}": must stay within the vault.`);
  }
  const full = join(vaultPath, cleaned);
  const rel = relative(vaultPath, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new VaultError(`Unsafe note path "${notePath}": resolves outside the vault.`);
  }
  return full;
}

/** Read a note's markdown content. */
export async function readNote(vaultPath: string, notePath: string): Promise<string> {
  return readFile(resolveInVault(vaultPath, notePath), "utf8");
}

/** Write a note, creating parent folders as needed. Overwrites by design — a task
 *  journal is keyed by a deterministic path so re-journaling just refreshes it. */
export async function writeNote(vaultPath: string, notePath: string, content: string): Promise<void> {
  const full = resolveInVault(vaultPath, notePath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

/** Delete a note. No-op (never throws) when it doesn't exist. */
export async function deleteNote(vaultPath: string, notePath: string): Promise<void> {
  await rm(resolveInVault(vaultPath, notePath), { force: true });
}

/** Every markdown note in the vault, as vault-relative POSIX paths, sorted. */
export async function listNotes(vaultPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // vault dir doesn't exist yet — no notes
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(relative(vaultPath, p).split(sep).join("/"));
    }
  }
  await walk(vaultPath);
  return out.sort();
}

/** A note's last-modified time (ISO-8601), or null if it can't be stat'd. */
export async function noteModifiedAt(vaultPath: string, notePath: string): Promise<string | null> {
  try {
    const s = await stat(resolveInVault(vaultPath, notePath));
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}
