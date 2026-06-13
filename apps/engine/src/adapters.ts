// Real adapters for the orchestrator ports. (TaskRepo from @bureau/db already
// satisfies TaskStore directly, so there's no adapter for it.)

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cloneRepo,
  createWorktree,
  getWorkingDiff,
  commitAll,
  push,
  openPr,
  removeWorktree,
  defaultRunner,
  type Runner,
  type CommitAuthor,
} from "@bureau/vcs";
import type { Message } from "@bureau/contracts";
import type { VcsPort, WorktreeRef, MessageLog } from "./ports.js";

export interface RealVcsConfig {
  readonly repoOwner: string;
  readonly repoName: string;
  /** A `git clone`-able source for the canonical clone (https/ssh/local path). */
  readonly repoUrl: string;
  readonly canonicalPath: string;
  /** Author identity for commits (so commits don't depend on global git config). */
  readonly author: CommitAuthor;
  readonly runner?: Runner;
}

/** Adapts @bureau/vcs free functions to the VcsPort the orchestrator depends on. */
export class RealVcs implements VcsPort {
  private readonly runner: Runner;
  constructor(private readonly cfg: RealVcsConfig) {
    this.runner = cfg.runner ?? defaultRunner;
  }

  private get ownerRepo(): string {
    return `${this.cfg.repoOwner}/${this.cfg.repoName}`;
  }

  async ensureClone(): Promise<void> {
    if (existsSync(join(this.cfg.canonicalPath, ".git"))) return; // already cloned
    await cloneRepo(this.cfg.repoUrl, this.cfg.canonicalPath, this.runner);
  }

  async setupWorktree(branch: string, worktreePath: string): Promise<WorktreeRef> {
    const handle = await createWorktree(this.cfg.canonicalPath, branch, worktreePath, this.runner);
    return { path: handle.path, branch: handle.branch };
  }

  workingDiff(worktreePath: string): Promise<string> {
    return getWorkingDiff(worktreePath, this.runner);
  }

  commitAll(worktreePath: string, message: string): Promise<boolean> {
    return commitAll(worktreePath, message, this.runner, this.cfg.author);
  }

  push(worktreePath: string, branch: string): Promise<void> {
    return push(worktreePath, branch, this.runner);
  }

  openPr(branch: string, title: string, body: string): Promise<string> {
    return openPr(this.ownerRepo, branch, title, body, this.runner);
  }

  async removeWorktree(ref: WorktreeRef, force: boolean): Promise<void> {
    await removeWorktree(
      { path: ref.path, branch: ref.branch, repoPath: this.cfg.canonicalPath },
      { force },
      this.runner
    );
  }
}

/** In-memory chat log for the slice (no messages table in Phase 1). */
export class InMemoryMessageLog implements MessageLog {
  private readonly items: Message[] = [];
  append(message: Message): void {
    this.items.push(message);
  }
  list(): Message[] {
    return [...this.items];
  }
}
