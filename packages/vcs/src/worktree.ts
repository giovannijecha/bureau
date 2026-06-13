// Worktree lifecycle — create / remove isolated git worktrees per task.
// TODO: implement in Phase 2. Stubs below define the contract.

export interface WorktreeHandle {
  readonly path: string;
  readonly branch: string;
}

/** Create a new isolated worktree for a task branch. */
export async function createWorktree(
  _canonicalClonePath: string,
  _branch: string,
  _worktreePath: string
): Promise<WorktreeHandle> {
  throw new Error("createWorktree: not yet implemented");
}

/** Remove a worktree when a task is done or aborted. */
export async function removeWorktree(_handle: WorktreeHandle): Promise<void> {
  throw new Error("removeWorktree: not yet implemented");
}
