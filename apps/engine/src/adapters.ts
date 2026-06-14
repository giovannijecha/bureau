// Real adapters for the orchestrator ports. (TaskRepo from @bureau/db already
// satisfies TaskStore directly, so there's no adapter for it.)

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  cloneRepo,
  createWorktree,
  getWorkingDiff,
  commitAll,
  push,
  openPr,
  mergePr,
  removeWorktree,
  defaultRunner,
  type Runner,
  type CommitAuthor,
} from "@bureau/vcs";
import { MessageRepo, ConversationRepo, type MessageRow, type ConversationRow } from "@bureau/db";
import type { Message, Conversation } from "@bureau/contracts";
import type { VcsPort, WorktreeRef, MessageLog, ConversationStore } from "./ports.js";

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

  mergePr(branch: string): Promise<void> {
    return mergePr(this.ownerRepo, branch, this.runner);
  }

  async removeWorktree(ref: WorktreeRef, force: boolean): Promise<void> {
    await removeWorktree(
      { path: ref.path, branch: ref.branch, repoPath: this.cfg.canonicalPath },
      { force },
      this.runner
    );
  }

  chatCwd(): string {
    if (existsSync(join(this.cfg.canonicalPath, ".git"))) return this.cfg.canonicalPath;
    // No clone yet — give Iris an empty scratch dir so her read tools find nothing
    // (never the engine's own working directory).
    const scratch = join(this.cfg.canonicalPath, "..", ".chat-scratch");
    mkdirSync(scratch, { recursive: true });
    return scratch;
  }
}

/** In-memory chat log (tests / ephemeral runs). */
export class InMemoryMessageLog implements MessageLog {
  private items: Message[] = [];
  append(message: Message): void {
    this.items.push(message);
  }
  list(): Message[] {
    return [...this.items];
  }
  listByConversation(conversationId: string): Message[] {
    return this.items.filter((m) => m.conversationId === conversationId);
  }
  adoptOrphans(conversationId: string): number {
    let n = 0;
    this.items = this.items.map((m) => {
      if (m.conversationId === undefined) {
        n++;
        return { ...m, conversationId };
      }
      return m;
    });
    return n;
  }
}

/** Durable chat log backed by the SQLite messages table — survives restarts.
 *  Maps the contracts Message ↔ the db MessageRow (undefined ↔ null). */
export class DbMessageLog implements MessageLog {
  constructor(private readonly repo: MessageRepo) {}

  append(message: Message): void {
    this.repo.append({
      id: message.id,
      conversationId: message.conversationId ?? null,
      role: message.role,
      content: message.content,
      taskId: message.taskId ?? null,
      createdAt: message.createdAt,
    });
  }

  list(): Message[] {
    return this.repo.list().map(toMessage);
  }

  listByConversation(conversationId: string): Message[] {
    return this.repo.listByConversation(conversationId).map(toMessage);
  }

  adoptOrphans(conversationId: string): number {
    return this.repo.adoptOrphans(conversationId);
  }
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    ...(r.taskId !== null ? { taskId: r.taskId } : {}),
    ...(r.conversationId !== null ? { conversationId: r.conversationId } : {}),
    createdAt: r.createdAt,
  };
}

/** Durable conversation store backed by the SQLite conversations table. */
export class DbConversationStore implements ConversationStore {
  constructor(private readonly repo: ConversationRepo) {}

  create(c: Conversation): void {
    this.repo.create({ id: c.id, title: c.title, projectId: c.projectId, createdAt: c.createdAt, updatedAt: c.updatedAt });
  }
  get(id: string): Conversation | null {
    const r = this.repo.get(id);
    return r ? toConversation(r) : null;
  }
  list(): Conversation[] {
    return this.repo.list().map(toConversation);
  }
  rename(id: string, title: string, updatedAt: string): void {
    this.repo.rename(id, title, updatedAt);
  }
  touch(id: string, updatedAt: string): void {
    this.repo.touch(id, updatedAt);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

function toConversation(r: ConversationRow): Conversation {
  return { id: r.id, title: r.title, projectId: r.projectId, createdAt: r.createdAt, updatedAt: r.updatedAt };
}
