// git/gh subprocess helpers.
// SAFETY: push() and openPr() MUST only be called after core.canPush() === true.
// This module does not enforce that — the engine layer does.

export async function cloneRepo(
  _ownerRepo: string,
  _destPath: string
): Promise<void> {
  throw new Error("cloneRepo: not yet implemented");
}

export async function getDiff(_worktreePath: string): Promise<string> {
  throw new Error("getDiff: not yet implemented");
}

/** Push branch to origin. Call ONLY after canPush() === true. */
export async function push(_worktreePath: string, _branch: string): Promise<void> {
  throw new Error("push: not yet implemented");
}

/** Open a PR via `gh`. Call ONLY after canPush() === true. */
export async function openPr(
  _ownerRepo: string,
  _branch: string,
  _title: string,
  _body: string
): Promise<string> {
  throw new Error("openPr: not yet implemented — returns PR URL");
}
