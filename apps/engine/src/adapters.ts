// Real adapters for the orchestrator ports. (TaskRepo from @bureau/db already
// satisfies TaskStore directly, so there's no adapter for it.)

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  cloneRepo,
  createWorktree,
  freshBase,
  syncToBase,
  getWorkingDiff,
  getDiff,
  getReviewDiff,
  commitAll,
  push,
  openPr,
  mergePr,
  removeWorktree,
  recentCommits,
  remoteBranches,
  headBranch,
  pruneTaskBranches,
  deleteTaskBranch,
  squashAllAndForcePush,
  forcePushWithLease,
  resetHardTo,
  createBranch,
  renameBranch,
  deleteLocalBranch,
  createTag,
  fetchOrigin,
  listTree,
  showFile,
  treeLastCommits,
  showCommit,
  listAllFiles,
  fileHistory,
  ghAccount,
  prList,
  issueList,
  defaultRunner,
  VcsError,
  type Runner,
  type CommitAuthor,
} from "@bureau/vcs";
import { readNote, writeNote, listNotes, noteModifiedAt, deleteNote } from "@bureau/mind";
import { MessageRepo, ConversationRepo, UsageRepo, NotificationRepo, type MessageRow, type ConversationRow, type NotificationRow } from "@bureau/db";
import type { Message, Conversation, Note, NoteSummary, UsageSummary, Notification, NotificationKind, GitFileEntry, PullRequest, Issue, EntryCommit, CommitDetail } from "@bureau/contracts";
import type { VcsPort, WorktreeRef, MessageLog, ConversationStore, MemoryPort, UsagePort, UsageEvent, NotificationStore, RepoView, RepoCommit, GitAdminOp } from "./ports.js";
import { noteSummary, notePath } from "./memory.js";
import { summarizeUsage } from "./usage.js";

export interface RealVcsConfig {
  readonly repoOwner: string;
  readonly repoName: string;
  /** A `git clone`-able source for the canonical clone (https/ssh/local path). */
  readonly repoUrl: string;
  readonly canonicalPath: string;
  /** The branch tasks merge into — every task branches off the LATEST of this
   *  (fetched from origin), not the clone's stale local copy. */
  readonly baseBranch: string;
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

  async syncClone(): Promise<void> {
    await this.ensureClone();
    // Refresh the clone's main working tree to origin's base so Iris reads the
    // LIVE repo, not a stale snapshot from clone time. Best-effort (no-op offline).
    await syncToBase(this.cfg.canonicalPath, this.cfg.baseBranch, this.runner);
  }

  async setupWorktree(branch: string, worktreePath: string): Promise<WorktreeRef> {
    // Branch off the LATEST base (fetched from origin) so the task doesn't start
    // from a stale local main and hit avoidable conflicts at merge time. Falls
    // back to the clone's HEAD when origin is unreachable.
    const base = await freshBase(this.cfg.canonicalPath, this.cfg.baseBranch, this.runner);
    const handle = await createWorktree(this.cfg.canonicalPath, branch, worktreePath, this.runner, base);
    return { path: handle.path, branch: handle.branch };
  }

  workingDiff(worktreePath: string): Promise<string> {
    return getWorkingDiff(worktreePath, this.runner);
  }

  branchDiff(worktreePath: string, base: string): Promise<string> {
    return getDiff(worktreePath, base, this.runner); // `git diff base...HEAD` (three-dot, merge-base relative)
  }

  reviewDiff(worktreePath: string, base: string): Promise<string> {
    return getReviewDiff(worktreePath, base, this.runner); // full change incl. uncommitted, vs base
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

  async repoInfo(commitLimit: number): Promise<RepoView> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) {
      return { cloned: false, branch: null, commits: [], branches: [] };
    }
    const [branch, commits, branches] = await Promise.all([
      headBranch(this.cfg.canonicalPath, this.runner),
      recentCommits(this.cfg.canonicalPath, commitLimit, this.runner),
      remoteBranches(this.cfg.canonicalPath, this.runner),
    ]);
    return { cloned: true, branch, commits, branches };
  }

  pruneTaskBranches(keep: readonly string[]): Promise<string[]> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) return Promise.resolve([]);
    return pruneTaskBranches(this.cfg.canonicalPath, keep, this.runner);
  }

  deleteBranch(branch: string): Promise<boolean> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) return Promise.resolve(false);
    return deleteTaskBranch(this.cfg.canonicalPath, branch, this.runner);
  }

  async gitAdmin(op: GitAdminOp): Promise<void> {
    await this.ensureClone();
    const p = this.cfg.canonicalPath;
    const id = this.cfg.author; // CommitAuthor is {name,email} — used only for commit ops
    switch (op.kind) {
      case "squash_all":
        return squashAllAndForcePush(p, op.branch, op.message, id, this.runner);
      case "force_push":
        return forcePushWithLease(p, op.branch, this.runner);
      case "reset_hard":
        return resetHardTo(p, op.ref, this.runner);
      case "create_branch":
        return createBranch(p, op.name, op.base, this.runner);
      case "rename_branch":
        return renameBranch(p, op.from, op.to, this.runner);
      case "delete_branch":
        return deleteLocalBranch(p, op.branch, this.runner);
      case "tag":
        return createTag(p, op.name, op.message, id, this.runner);
      case "fetch":
        return fetchOrigin(p, this.runner);
    }
  }

  async listTree(ref: string, dir: string): Promise<GitFileEntry[]> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) return [];
    return listTree(this.cfg.canonicalPath, ref, dir, this.runner);
  }

  showFile(ref: string, path: string): Promise<{ content: string; truncated: boolean }> {
    // Parity with the other read-only browser adapters: a typed VcsError (→ 400/“not
    // cloned”) instead of letting `git show` fail into a generic 500.
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) throw new VcsError("Repository isn't cloned yet.");
    return showFile(this.cfg.canonicalPath, ref, path, this.runner);
  }

  githubAccount(): Promise<{ login: string; name: string | null } | null> {
    return ghAccount(this.runner);
  }

  prList(): Promise<PullRequest[]> {
    return prList(this.ownerRepo, this.runner);
  }

  issueList(): Promise<Issue[]> {
    return issueList(this.ownerRepo, this.runner);
  }

  async treeCommits(ref: string, dir: string): Promise<EntryCommit[]> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) return [];
    return treeLastCommits(this.cfg.canonicalPath, ref, dir, this.runner);
  }

  async commitDetail(ref: string): Promise<CommitDetail | null> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) return null;
    const d = await showCommit(this.cfg.canonicalPath, ref, this.runner);
    // The vcs type is readonly; the contract type is mutable — copy into a fresh shape.
    return d ? { ...d, files: d.files.map((f) => ({ ...f })) } : null;
  }

  async listFiles(ref: string): Promise<{ paths: string[]; truncated: boolean }> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) return { paths: [], truncated: false };
    return listAllFiles(this.cfg.canonicalPath, ref, this.runner);
  }

  async fileHistory(ref: string, path: string): Promise<RepoCommit[]> {
    if (!existsSync(join(this.cfg.canonicalPath, ".git"))) return [];
    return fileHistory(this.cfg.canonicalPath, ref, path, 50, this.runner);
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

/** Usage & Cost backed by the SQLite usage_events table. */
export class DbUsage implements UsagePort {
  constructor(private readonly repo: UsageRepo) {}

  record(event: UsageEvent): void {
    this.repo.record({ ...event });
  }

  summary(sinceDay: string | null): UsageSummary {
    return summarizeUsage(this.repo.since(sinceDay ?? undefined), sinceDay);
  }
}

/** Durable CEO notifications backed by the SQLite notifications table. */
export class DbNotifications implements NotificationStore {
  constructor(private readonly repo: NotificationRepo) {}

  create(n: Notification): void {
    this.repo.create({ ...n });
  }
  list(limit?: number): Notification[] {
    return this.repo.list(limit).map(toNotification);
  }
  unreadCount(): number {
    return this.repo.unreadCount();
  }
  markRead(id: string, readAt: string): void {
    this.repo.markRead(id, readAt);
  }
  markAllRead(readAt: string): void {
    this.repo.markAllRead(readAt);
  }
}

function toNotification(r: NotificationRow): Notification {
  return { id: r.id, kind: r.kind as NotificationKind, taskId: r.taskId, subject: r.subject, body: r.body, createdAt: r.createdAt, readAt: r.readAt };
}

/** System Memory backed by an on-disk markdown vault (@bureau/mind). */
export class VaultStore implements MemoryPort {
  constructor(private readonly vaultPath: string) {}

  async list(query?: string): Promise<NoteSummary[]> {
    const paths = await listNotes(this.vaultPath);
    const notes = await Promise.all(paths.map((p) => this.read(p)));
    const q = query?.trim().toLowerCase();
    return notes
      .filter((n): n is Note => n !== null)
      .filter((n) => !q || `${n.title}\n${n.path}\n${n.body}`.toLowerCase().includes(q))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map(({ body: _body, ...summary }) => summary);
  }

  async get(path: string): Promise<Note | null> {
    return this.read(path);
  }

  async saveNote(title: string, body: string): Promise<Note> {
    const path = notePath(title);
    // Store with an H1 title so the note round-trips with a stable title.
    const content = `# ${title}\n\n${body.trim()}\n`;
    await writeNote(this.vaultPath, path, content);
    const note = await this.read(path);
    if (!note) throw new Error(`Failed to read back note ${path} after saving.`);
    return note;
  }

  async delete(path: string): Promise<void> {
    await deleteNote(this.vaultPath, path);
  }

  async writeJournal(path: string, markdown: string): Promise<void> {
    await writeNote(this.vaultPath, path, markdown);
  }

  private async read(path: string): Promise<Note | null> {
    let content: string;
    try {
      content = await readNote(this.vaultPath, path);
    } catch {
      return null;
    }
    const updatedAt = (await noteModifiedAt(this.vaultPath, path)) ?? new Date(0).toISOString();
    return { ...noteSummary(path, content, updatedAt), body: content };
  }
}

/** In-memory vault for tests / ephemeral runs. */
export class InMemoryMemory implements MemoryPort {
  private readonly notes = new Map<string, { content: string; updatedAt: string }>();
  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  async list(query?: string): Promise<NoteSummary[]> {
    const q = query?.trim().toLowerCase();
    return [...this.notes.entries()]
      .map(([path, v]) => ({ ...noteSummary(path, v.content, v.updatedAt), body: v.content }))
      .filter((n) => !q || `${n.title}\n${n.path}\n${n.body}`.toLowerCase().includes(q))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map(({ body: _body, ...summary }) => summary);
  }

  async get(path: string): Promise<Note | null> {
    const v = this.notes.get(path);
    return v ? { ...noteSummary(path, v.content, v.updatedAt), body: v.content } : null;
  }

  async saveNote(title: string, body: string): Promise<Note> {
    const path = notePath(title);
    const content = `# ${title}\n\n${body.trim()}\n`;
    this.notes.set(path, { content, updatedAt: this.clock() });
    return (await this.get(path))!;
  }

  async delete(path: string): Promise<void> {
    this.notes.delete(path);
  }

  async writeJournal(path: string, markdown: string): Promise<void> {
    this.notes.set(path, { content: markdown, updatedAt: this.clock() });
  }
}
