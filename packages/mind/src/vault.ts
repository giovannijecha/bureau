// Obsidian vault adapter — markdown read/write stubs.
// TODO: implement in a later phase.

export async function readNote(_vaultPath: string, _notePath: string): Promise<string> {
  throw new Error("readNote: not yet implemented");
}

export async function writeNote(
  _vaultPath: string,
  _notePath: string,
  _content: string
): Promise<void> {
  throw new Error("writeNote: not yet implemented");
}

export async function listNotes(_vaultPath: string): Promise<string[]> {
  throw new Error("listNotes: not yet implemented");
}
