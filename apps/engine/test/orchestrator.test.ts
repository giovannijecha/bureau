import { describe, it, expect, beforeEach } from "vitest";

import { canPush } from "@bureau/core";
import type { Task } from "@bureau/core";
import { CapabilityRegistry } from "@bureau/capabilities";
import type { CapabilityInput } from "@bureau/capabilities";
import type { Provider } from "@bureau/providers";
import { DEFAULT_CLI_IDLE_MS, DEFAULT_CLI_CEILING_MS } from "@bureau/providers";
import type { WsEvent, Message, TaskProposal, Conversation } from "@bureau/contracts";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, ProjectRepo } from "@bureau/db";
import { Orchestrator, buildRepoContext } from "../src/orchestrator.js";
import { ProjectRegistry, type ProjectConfig } from "../src/projects.js";
import type { TaskStore, VcsPort, MessageLog, ConversationStore, MemoryPort, UsagePort, UsageEvent, NotificationStore } from "../src/ports.js";
import type { Notification } from "@bureau/contracts";
import { toTaskDetail, isMerged, prOpen } from "../src/summary.js";

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeStore() {
  const map = new Map<string, Task>();
  const store: TaskStore = {
    save: (t) => void map.set(t.id, t),
    load: (id) => map.get(id) ?? null,
    list: () => [...map.values()],
    delete: (id) => void map.delete(id),
  };
  return { store, map };
}

function fakeVcs() {
  const calls = {
    ensureClone: 0,
    syncClone: 0,
    workingDiff: 0,
    branchDiff: 0,
    reviewDiff: 0,
    pruneKeep: [] as string[],
    deletedBranch: null as string | null,
    setupWorktree: [] as { branch: string; path: string }[],
    resetWorktreeToBase: [] as string[],
    pruneWorktrees: 0,
    commitAll: [] as { path: string; message: string }[],
    push: [] as { path: string; branch: string }[],
    openPr: [] as { branch: string; title?: string; body?: string }[],
    mergePr: [] as { branch: string }[],
    establishBase: [] as { worktreePath?: string; branch: string; fromOrigin: boolean }[],
    setDefaultBranch: 0,
    removeWorktree: [] as { force: boolean }[],
    gitAdmin: [] as string[],
  };
  let committed = true;
  let mergeError: string | null = null;
  let baseEmpty = false; // simulate a brand-new repo with no base branch on origin
  const vcs: VcsPort = {
    async ensureClone() {
      calls.ensureClone++;
    },
    async syncClone() {
      calls.syncClone++;
    },
    async setupWorktree(branch, path) {
      calls.setupWorktree.push({ branch, path });
      return { path, branch };
    },
    async resetWorktreeToBase(path) {
      calls.resetWorktreeToBase.push(path);
    },
    async pruneWorktrees() {
      calls.pruneWorktrees++;
    },
    async workingDiff() {
      calls.workingDiff++;
      return "DIFF-CONTENT";
    },
    async branchDiff() {
      calls.branchDiff++;
      return "REVISED-DIFF-CONTENT";
    },
    async reviewDiff() {
      calls.reviewDiff++;
      return "REVIEW-DIFF-CONTENT";
    },
    async commitAll(path, message) {
      calls.commitAll.push({ path, message });
      return committed;
    },
    async push(path, branch) {
      calls.push.push({ path, branch });
    },
    async openPr(branch, title, body) {
      calls.openPr.push({ branch, title, body });
      return "https://github.com/acme/widget/pull/1";
    },
    async mergePr(branch) {
      calls.mergePr.push({ branch });
      if (mergeError !== null) throw new Error(mergeError);
    },
    async baseExists() {
      return !baseEmpty;
    },
    async establishBase(worktreePath, branch) {
      calls.establishBase.push({ worktreePath, branch, fromOrigin: false });
      if (mergeError !== null) throw new Error(mergeError);
      baseEmpty = false; // the base now exists
    },
    async establishBaseFromOrigin(branch) {
      calls.establishBase.push({ branch, fromOrigin: true });
      if (mergeError !== null) throw new Error(mergeError);
      baseEmpty = false;
    },
    async setDefaultBranch() {
      calls.setDefaultBranch++;
    },
    async removeWorktree(_ref, force) {
      calls.removeWorktree.push({ force });
    },
    chatCwd: () => "/tmp/clone",
    async repoInfo() {
      return { cloned: true, branch: "main", commits: [{ hash: "abc1234", author: "Bureau", date: "2026-06-14", subject: "Initial commit" }], branches: ["main"] };
    },
    async pruneTaskBranches(keep) {
      calls.pruneKeep = [...keep];
      return ["bureau/task-old1", "bureau/task-old2"];
    },
    async deleteBranch(branch) {
      calls.deletedBranch = branch;
      return true;
    },
    async gitAdmin(op) {
      calls.gitAdmin.push(op.kind);
    },
    async isEmpty() {
      return false;
    },
    async listTree() {
      return [];
    },
    async showFile() {
      return { content: "", truncated: false };
    },
    async githubAccount() {
      return { login: "octocat", name: "Octo Cat" };
    },
    async prList() {
      return [];
    },
    async issueList() {
      return [];
    },
    async treeCommits() {
      return [];
    },
    async commitDetail() {
      return null;
    },
    async listFiles() {
      return { paths: [], truncated: false };
    },
    async fileHistory() {
      return [];
    },
  };
  return {
    vcs,
    calls,
    setCommitted: (v: boolean) => void (committed = v),
    setMergeError: (v: string | null) => void (mergeError = v),
    setBaseEmpty: (v: boolean) => void (baseEmpty = v),
  };
}

function fakeMessages(): MessageLog {
  let items: Message[] = [];
  return {
    append: (m) => void items.push(m),
    list: () => items,
    listByConversation: (cid) => items.filter((m) => m.conversationId === cid),
    adoptOrphans: (cid) => {
      let n = 0;
      items = items.map((m) => (m.conversationId === undefined ? (n++, { ...m, conversationId: cid }) : m));
      return n;
    },
  };
}

function fakeConversations(): ConversationStore {
  const map = new Map<string, Conversation>();
  const summaries = new Map<string, { summary: string | null; count: number }>();
  return {
    create: (c) => void map.set(c.id, c),
    get: (id) => map.get(id) ?? null,
    list: () => [...map.values()],
    rename: (id, title, updatedAt) => {
      const c = map.get(id);
      if (c) map.set(id, { ...c, title, updatedAt });
    },
    touch: (id, updatedAt) => {
      const c = map.get(id);
      if (c) map.set(id, { ...c, updatedAt });
    },
    summaryOf: (id) => (map.has(id) ? (summaries.get(id) ?? { summary: null, count: 0 }) : null),
    setSummary: (id, summary, count) => void summaries.set(id, { summary, count }),
    delete: (id) => void (map.delete(id), summaries.delete(id)),
  };
}

function fakeMemory() {
  const journals: { path: string; markdown: string }[] = [];
  const saved: { title: string; body: string }[] = [];
  const archived: string[] = [];
  const memory: MemoryPort = {
    async list() {
      return [];
    },
    async get() {
      return null;
    },
    async saveNote(title, body) {
      saved.push({ title, body });
      return { path: `notes/${title}.md`, title, kind: "note", updatedAt: "t", excerpt: "", body };
    },
    async delete() {},
    async archive(path) {
      archived.push(path);
    },
    async count() {
      const all = await memory.list();
      return { notes: all.filter((n) => n.kind === "note").length, journals: all.filter((n) => n.kind === "journal").length };
    },
    async writeJournal(path, markdown) {
      journals.push({ path, markdown });
    },
    root() {
      return null;
    },
  };
  return { memory, journals, saved, archived };
}

function fakeNotifications() {
  const items: Notification[] = [];
  const store: NotificationStore = {
    create: (n) => void items.unshift(n),
    list: () => items,
    unreadCount: () => items.filter((n) => n.readAt === null).length,
    markRead: (id, at) => {
      const i = items.findIndex((n) => n.id === id);
      if (i >= 0) items[i] = { ...items[i]!, readAt: at };
    },
    markAllRead: (at) => items.forEach((n, i) => (items[i] = { ...n, readAt: at })),
  };
  return { store, items };
}

function fakeUsage() {
  const events: UsageEvent[] = [];
  const usage: UsagePort = {
    record: (e) => void events.push(e),
    summary: () => ({ totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, events: 0 }, byScope: [], byModel: [], byDay: [], sinceDay: null }),
  };
  return { usage, events };
}

const PROPOSAL: TaskProposal = {
  title: "Add a Quick Start to the README",
  summary: "Document how to run the project",
  steps: [{ capability: "edit", description: "Add a Quick Start section to README.md" }],
};

function fakeProvider(reply: string) {
  let content = reply;
  let lastSystem = ""; // the system prompt of the most recent turn (for context assertions)
  const sysOf = (m: { role: string; content: string }[]) => m.find((x) => x.role === "system")?.content ?? "";
  const provider: Provider = {
    name: "fake",
    authStrategy: { kind: "api-key", isAvailable: () => true },
    async send(m) {
      lastSystem = sysOf(m);
      return { content, inputTokens: 0, outputTokens: 0 };
    },
    async stream(m, onChunk) {
      lastSystem = sysOf(m);
      onChunk(content);
      return { content, inputTokens: 0, outputTokens: 0 };
    },
  };
  return { provider, setReply: (r: string) => void (content = r), system: () => lastSystem };
}

const PROJECT: ProjectConfig = {
  id: "widget",
  owner: "acme",
  name: "widget",
  url: "file:///repos/acme/widget.git",
  baseBranch: "main",
  canonicalPath: "/tmp/acme/widget/repo",
  worktreesDir: "/tmp/acme/widget/worktrees",
  testCommand: ["npm", "test"],
};

let store: TaskStore;
let vcs: ReturnType<typeof fakeVcs>;
let projectRepo: ProjectRepo;
let mem: ReturnType<typeof fakeMemory>;
let usage: ReturnType<typeof fakeUsage>;
let notifs: ReturnType<typeof fakeNotifications>;
let prov: ReturnType<typeof fakeProvider>;
let captured: CapabilityInput | null;
let reviewInput: CapabilityInput | null;
let testInput: CapabilityInput | null;
let testSummary = "✓ Tests passed — `npm test` exited 0.";
let events: WsEvent[];
let orch: Orchestrator;
/** When set, the fake edit capability blocks on this until released — lets a test
 *  freeze the pipeline mid-step to exercise the stop-while-running race. */
let editGate: Promise<void> | null;

/** Poll until `pred` holds (the pipeline runs in the background). */
async function until(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  store = fakeStore().store;
  vcs = fakeVcs();
  const db = createDb(":memory:");
  runMigrations(db);
  projectRepo = new ProjectRepo(db);
  mem = fakeMemory();
  usage = fakeUsage();
  notifs = fakeNotifications();
  prov = fakeProvider(JSON.stringify({ reply: "Sure!", proposal: PROPOSAL }));
  const registry = new CapabilityRegistry();
  captured = null;
  editGate = null;
  registry.register({
    kind: "edit",
    async execute(input) {
      captured = input;
      input.onChunk?.("editing README.md…\nAdded a Status section.");
      if (editGate) await editGate;
      return { artifacts: [], summary: "Added a Status section.", usage: { inputTokens: 1000, outputTokens: 200, model: "claude-opus-4-8" } };
    },
  });
  reviewInput = null;
  registry.register({
    kind: "review",
    async execute(input) {
      reviewInput = input;
      input.onChunk?.("reading the diff…\nLooks good.");
      return { artifacts: [], summary: "Looks good." };
    },
  });
  registry.register({
    kind: "plan",
    async execute() {
      return { artifacts: [], summary: "PLAN: edit README.md and add a Status section." };
    },
  });
  testInput = null;
  testSummary = "✓ Tests passed — `npm test` exited 0.";
  registry.register({
    kind: "test",
    async execute(input) {
      testInput = input;
      return { artifacts: [], summary: testSummary };
    },
  });
  events = [];
  let n = 0;
  orch = new Orchestrator({
    store,
    capabilities: registry,
    provider: prov.provider,
    projects: new ProjectRegistry([PROJECT]),
    projectRepo,
    reposRoot: "/repos",
    vcs: () => vcs.vcs,
    events: { emit: (e) => void events.push(e) },
    messages: fakeMessages(),
    conversations: fakeConversations(),
    memory: mem.memory,
    usage: usage.usage,
    notifications: notifs.store,
    // The verify loop runs on every mutating task (PROJECT has a testCommand) — a passing fake
    // runner keeps it silent on the happy path. The dedicated "verify loop" suite injects its own.
    commandRunner: async () => ({ stdout: "ok", stderr: "", code: 0, timedOut: false }),
    ids: () => `id-${++n}`,
    clock: () => "2026-06-13T00:00:00.000Z",
  });
});

// ── projects ─────────────────────────────────────────────────────────────────

describe("projects", () => {
  it("lists projects as DTOs (no urls or on-disk paths leaked)", () => {
    expect(orch.listProjects()).toEqual([{ id: "widget", owner: "acme", name: "widget", baseBranch: "main", testCommand: ["npm", "test"] }]);
  });

  it("resolves a task's project by its stable id, even when two projects share owner/name", async () => {
    // A and B are distinct repos (different clones/urls) that happen to share
    // owner/name — find(owner,name) would return the FIRST (A); resolution must
    // use the task's projectId so the work + push target the project the CEO chose.
    const A: ProjectConfig = { id: "a", owner: "acme", name: "widget", url: "u-a", baseBranch: "main", canonicalPath: "/a/repo", worktreesDir: "/a/wt" };
    const B: ProjectConfig = { id: "b", owner: "acme", name: "widget", url: "u-b", baseBranch: "main", canonicalPath: "/b/repo", worktreesDir: "/b/wt" };
    const seen: string[] = [];
    let k = 0;
    const reg = new CapabilityRegistry();
    reg.register({ kind: "edit", async execute() { return { artifacts: [], summary: "" }; } });
    const o = new Orchestrator({
      store,
      capabilities: reg,
      provider: prov.provider,
      projects: new ProjectRegistry([A, B]),
      projectRepo,
      reposRoot: "/repos",
      vcs: (p) => {
        seen.push(p.id);
        return vcs.vcs;
      },
      events: { emit: () => {} },
      messages: fakeMessages(),
      conversations: fakeConversations(),
      memory: fakeMemory().memory,
      usage: fakeUsage().usage,
      notifications: fakeNotifications().store,
      ids: () => `r-${++k}`,
      clock: () => "2026-06-13T00:00:00.000Z",
    });

    const draft = o.createTask(PROPOSAL, "b");
    expect(draft.projectId).toBe("b");
    await o.startTask(draft.id);
    await o.settle(draft.id);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((id) => id === "b")).toBe(true); // never resolved to A, the first owner/name match
  });

  it("addProject validates the URL, clones, registers in the SHARED registry, persists, and emits", async () => {
    const before = vcs.calls.ensureClone;
    const dto = await orch.addProject({ url: "https://github.com/globex/api" });
    expect(dto).toEqual({ id: "globex-api", owner: "globex", name: "api", baseBranch: "main" });
    expect(orch.listProjects().map((p) => p.id)).toContain("globex-api"); // the one shared registry reflects it
    expect(projectRepo.get("globex-api")?.url).toBe("https://github.com/globex/api"); // persisted to DB
    expect(vcs.calls.ensureClone).toBe(before + 1); // cloned eagerly
    expect(events.some((e) => e.type === "projects_changed")).toBe(true);
  });

  it("addProject rejects a duplicate and an unsafe URL", async () => {
    await orch.addProject({ url: "https://github.com/globex/api" });
    await expect(orch.addProject({ url: "https://github.com/globex/api" })).rejects.toThrow(/already exists/);
    await expect(orch.addProject({ url: "file:///etc/passwd" })).rejects.toThrow();
  });

  it("addProject rolls back the persisted row when the clone fails", async () => {
    vcs.vcs.ensureClone = async () => {
      throw new Error("network down");
    };
    await expect(orch.addProject({ url: "https://github.com/globex/api" })).rejects.toThrow(/Couldn't clone/);
    expect(projectRepo.get("globex-api")).toBeNull(); // row rolled back
    expect(orch.listProjects().map((p) => p.id)).not.toContain("globex-api"); // not registered
  });

  it("removeProject refuses while a non-terminal task references it (409), then removes a free one", async () => {
    await orch.addProject({ url: "https://github.com/globex/api" }); // 2 projects now
    const draft = orch.createTask(PROPOSAL, "widget"); // a 'created' (non-terminal) task on the default project
    expect(draft.projectId).toBe("widget");
    await expect(orch.removeProject("widget")).rejects.toThrow(expect.objectContaining({ status: 409 }));
    await orch.removeProject("globex-api"); // no tasks reference it → clean removal
    expect(orch.listProjects().map((p) => p.id)).not.toContain("globex-api");
    expect(projectRepo.get("globex-api")).toBeNull();
    expect(events.some((e) => e.type === "projects_changed")).toBe(true);
  });
});

// ── budget guard ─────────────────────────────────────────────────────────────

describe("budget guard", () => {
  it("aborts a running task once its spend crosses the cap, before committing/gating", async () => {
    // The fake edit step costs $0.01 (1000 in*$5 + 200 out*$25 per 1M). Cap below that.
    orch.setBudget(0.005);
    const draft = orch.createTask(PROPOSAL, "widget");
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    const task = store.load(draft.id)!;
    expect(task.status).toBe("aborted");
    expect(task.decisionLog.some((e) => e.type === "task_aborted" && /budget cap/i.test(e.reason))).toBe(true);
    // It stopped BEFORE the commit/gate — no PR was ever opened.
    expect(vcs.calls.commitAll).toHaveLength(0);
    expect(vcs.calls.openPr).toHaveLength(0);
  });

  it("does not abort when the spend stays under the cap (or when there's no cap)", async () => {
    orch.setBudget(1); // $1 cap, well above the $0.01 edit
    const draft = orch.createTask(PROPOSAL, "widget");
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    const task = store.load(draft.id)!;
    expect(task.status).not.toBe("aborted"); // parks at the review gate as usual
  });

  it("engineInfo reports the cap; setBudget clamps a negative to 0", () => {
    expect(orch.setBudget(2.5)).toBe(2.5);
    expect(orch.engineInfo().budgetUsd).toBe(2.5);
    expect(orch.setBudget(-5)).toBe(0);
  });
});

// ── resume / recovery (interrupted tasks) ────────────────────────────────────

describe("resume & recovery", () => {
  it("resumeTask re-runs an interrupted task to the review gate — and NEVER pushes", async () => {
    const draft = orch.createTask(PROPOSAL, "widget");
    store.save({ ...store.load(draft.id)!, status: "interrupted" });
    await orch.resumeTask(draft.id);
    await orch.settle(draft.id);
    const after = store.load(draft.id)!;
    expect(after.status).toBe("awaiting_human"); // re-ran cleanly to the gate
    expect(vcs.calls.pruneWorktrees).toBeGreaterThan(0); // recreate path prunes stale entries first
    expect(vcs.calls.setupWorktree.length).toBeGreaterThan(0);
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.openPr).toHaveLength(0);
    expect(vcs.calls.mergePr).toHaveLength(0);
  });

  it("resumeTask resets an EXISTING worktree to base instead of recreating it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bureau-wt-"));
    mkdirSync(join(dir, ".git"));
    try {
      const draft = orch.createTask(PROPOSAL, "widget");
      store.save({ ...store.load(draft.id)!, status: "interrupted", worktreePath: dir });
      await orch.resumeTask(draft.id);
      await orch.settle(draft.id);
      expect(vcs.calls.resetWorktreeToBase).toContain(dir);
      expect(vcs.calls.setupWorktree).toHaveLength(0); // reused, not recreated
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumeTask rejects a task that isn't interrupted (409)", async () => {
    const draft = orch.createTask(PROPOSAL, "widget");
    await expect(orch.resumeTask(draft.id)).rejects.toThrow(expect.objectContaining({ status: 409 }));
  });

  it("discardTask aborts an interrupted task and tears down its worktree", async () => {
    const draft = orch.createTask(PROPOSAL, "widget");
    store.save({ ...store.load(draft.id)!, status: "interrupted", worktreePath: "/tmp/wt" });
    const after = await orch.discardTask(draft.id);
    expect(after.status).toBe("aborted");
    expect(vcs.calls.removeWorktree.length).toBeGreaterThan(0);
  });
});

// ── chat ─────────────────────────────────────────────────────────────────────

describe("chat", () => {
  it("syncs the clone so Iris reads the live repo, returns the reply + proposal, and starts no task", async () => {
    const res = await orch.chat("add a quick start to the readme");
    expect(res.reply.role).toBe("iris");
    expect(res.reply.content).toBe("Sure!");
    expect(res.proposal).toEqual(PROPOSAL);
    expect(vcs.calls.syncClone).toBe(1); // refreshed the clone to the live repo first
    expect(vcs.calls.commitAll).toHaveLength(0); // chatting changes nothing
    expect(store.list()).toHaveLength(0); // and creates no task
  });

  it("returns just a reply when Iris is only chatting (no proposal)", async () => {
    prov.setReply(JSON.stringify({ reply: "Tell me more." }));
    const res = await orch.chat("hi");
    expect(res.reply.content).toBe("Tell me more.");
    expect(res.proposal).toBeUndefined();
  });

  it("leaves a SHORT thread uncompacted — full history verbatim, no summary, no nudge", async () => {
    const res = await orch.chat("hi");
    expect(res.notice).toBeUndefined();
    expect(prov.system()).not.toContain("Conversation so far"); // no summary injected
  });

  it("COMPACTS a long thread — folds older turns into a summary, keeps recent verbatim, nudges ONCE", async () => {
    const big = "x".repeat(7000);
    prov.setReply(JSON.stringify({ reply: big })); // each turn adds ~14k chars (user + iris)
    let res = await orch.chat(big); // turn 1 — under budget
    const convId = res.conversationId;
    let notices = 0;
    for (let i = 0; i < 5; i++) {
      res = await orch.chat(big, undefined, convId); // grow well past the 24k budget
      if (res.notice) notices++;
    }
    expect(notices).toBe(1); // nudged exactly once (first crossing), never spammed
    expect(prov.system()).toContain("Conversation so far"); // the rolling summary rode into Iris's context
  });

  it("folds THIS project's journals into Iris's context as a READABLE, scoped index (research reaches chat)", async () => {
    // The active project resolves to acme/widget. A journal from ANOTHER repo must NOT leak in.
    // list() carries each journal's repo (the real stores parse it once via noteSummary), so the
    // chat scopes by it WITHOUT re-reading each file.
    mem.memory.list = async () => [
      { path: "journals/2026-06-19-research-opencode.md", title: "Research: stack OpenCode", kind: "journal", updatedAt: "2026-06-19T09:54:00.000Z", excerpt: "Status: completed.", repo: "acme/widget" },
      { path: "journals/2026-06-18-other.md", title: "Other repo secret task", kind: "journal", updatedAt: "2026-06-18T00:00:00.000Z", excerpt: "Status: completed.", repo: "other/repo" },
    ];
    mem.memory.get = async (p: string) =>
      p.includes("opencode")
        ? { path: p, title: "Research: stack OpenCode", kind: "journal", updatedAt: "t", excerpt: "Status: completed.", body: "# Research: stack OpenCode\n\n- **Repo:** acme/widget\n\n## Reports\n\nOpenTUI + SolidJS." }
        : { path: p, title: "Other repo secret task", kind: "journal", updatedAt: "t", excerpt: "Status: completed.", body: "# Other\n\n- **Repo:** other/repo\n" };

    await orch.chat("cosa ha trovato la ricerca su OpenCode?");
    const sys = prov.system();
    expect(sys).toContain("Past task records for acme/widget"); // scoped heading
    expect(sys).toContain("Research: stack OpenCode"); // this project's journal — title (Iris knows it exists)
    expect(sys).toContain("journals/2026-06-19-research-opencode.md"); // its path (so she can Read it)
    expect(sys).toContain("(2026-06-19)"); // date — disambiguates same-goal tasks
    expect(sys).toContain("Status: completed."); // outcome excerpt — shallow recall without a Read
    expect(sys).not.toContain("Other repo secret task"); // a DIFFERENT repo's journal is scoped OUT
  });

  it("still injects free-form pinned notes in FULL (authoritative facts)", async () => {
    mem.memory.list = async () => [{ path: "notes/std.md", title: "Coding standards", kind: "note", updatedAt: "t", excerpt: "2-space" }];
    mem.memory.get = async () => ({ path: "notes/std.md", title: "Coding standards", kind: "note", updatedAt: "t", excerpt: "2-space", body: "Always use 2-space indent." });
    await orch.chat("hi");
    expect(prov.system()).toContain("Always use 2-space indent.");
  });
});

// ── task context (the decided brief reaches the workers) ─────────────────────

describe("proposal context", () => {
  it("carries the decided brief from the proposal into the worker's prompt — the workers never see the chat", async () => {
    const draft = orch.createTask({
      title: "Scaffold Dante",
      summary: "Lay out the modules",
      context:
        "Build a CLI agent on Bun with an OpenTUI/SolidJS TUI, an agent-core loop, and a multi-model provider layer. Do NOT add Supabase or any database.",
      steps: [{ capability: "edit", description: "Create the module skeleton" }],
    });
    expect(draft.context).toContain("OpenTUI/SolidJS"); // persisted on the task

    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    // The edit worker's context carried the brief — including the explicit exclusion, so it
    // builds what was decided (not a generic backend, and not Supabase).
    expect(captured?.context).toContain("OpenTUI/SolidJS");
    expect(captured?.context).toContain("Do NOT add Supabase");
  });

  it("omits context cleanly when the proposal has none (older / trivial tasks)", async () => {
    const draft = orch.createTask(PROPOSAL); // no context field
    expect(draft.context).toBeUndefined();
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    expect(captured?.context).not.toContain("decided for this task");
  });

  it("caps a runaway brief — it's re-sent on every step, so it can't grow unbounded", () => {
    const draft = orch.createTask({
      title: "T",
      summary: "S",
      context: "X".repeat(20_000),
      steps: [{ capability: "edit", description: "d" }],
    });
    expect(draft.context!.length).toBeLessThan(20_000);
    expect(draft.context).toContain("[brief truncated]");
  });
});

describe("cleanupTaskBranches", () => {
  it("keeps the branches of in-flight tasks and prunes the rest (returns the deleted)", async () => {
    const live = orch.createTask(PROPOSAL);
    await orch.startTask(live.id);
    await orch.settle(live.id); // parked at the gate → still in flight, keep its branch
    const done = orch.createTask(PROPOSAL);
    await orch.startTask(done.id);
    await orch.settle(done.id);
    await orch.confirmMerge(done.id); // completed → its branch may be pruned

    const res = await orch.cleanupTaskBranches();
    expect(vcs.calls.pruneKeep).toContain(`bureau/task-${live.id}`); // the parked task is kept
    expect(vcs.calls.pruneKeep).not.toContain(`bureau/task-${done.id}`); // the merged one is prunable
    expect(res.deleted).toEqual(["bureau/task-old1", "bureau/task-old2"]);
  });
});

describe("deleteBranch", () => {
  it("deletes a single task branch via the vcs layer (terminal task)", async () => {
    const t = orch.createTask(PROPOSAL);
    await orch.startTask(t.id);
    await orch.settle(t.id);
    await orch.confirmMerge(t.id); // → completed (terminal, no longer in flight)

    const res = await orch.deleteBranch(`bureau/task-${t.id}`);
    expect(res.deleted).toBe(true);
    expect(vcs.calls.deletedBranch).toBe(`bureau/task-${t.id}`);
  });

  it("refuses (400) a non-task branch name and never reaches the vcs layer", async () => {
    await expect(orch.deleteBranch("main")).rejects.toMatchObject({ status: 400 });
    await expect(orch.deleteBranch("release/1.0")).rejects.toMatchObject({ status: 400 });
    expect(vcs.calls.deletedBranch).toBeNull(); // the regex guard short-circuits before the vcs call
  });

  it("refuses (409) to delete the branch of an in-flight task — it still needs it", async () => {
    let release!: () => void;
    editGate = new Promise<void>((r) => (release = r));
    const t = orch.createTask(PROPOSAL);
    await orch.startTask(t.id);
    await until(() => store.load(t.id)!.status === "executing");

    await expect(orch.deleteBranch(`bureau/task-${t.id}`)).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.deletedBranch).toBeNull(); // never reached the vcs layer

    release();
    await orch.settle(t.id);
  });
});

describe("runGitOp — CEO-authorized git operations (type-to-confirm gate)", () => {
  it("rejects (400) a destructive op with missing / wrong confirmation, never reaching the vcs layer", async () => {
    await expect(orch.runGitOp({ kind: "force_push", branch: "main" })).rejects.toMatchObject({ status: 400 });
    await expect(orch.runGitOp({ kind: "force_push", branch: "main", confirmation: "MAIN" })).rejects.toMatchObject({ status: 400 }); // case-sensitive
    await expect(orch.runGitOp({ kind: "squash_all", branch: "main", message: "one", confirmation: "mian" })).rejects.toMatchObject({ status: 400 });
    expect(vcs.calls.gitAdmin).toEqual([]); // the confirm gate short-circuits before execution
  });

  it("runs a destructive op only when confirmation EXACTLY matches the target branch", async () => {
    const res = await orch.runGitOp({ kind: "force_push", branch: "main", confirmation: "main" });
    expect(res.ok).toBe(true);
    expect(vcs.calls.gitAdmin).toEqual(["force_push"]);
  });

  it("runs a SAFE op with no confirmation required", async () => {
    const res = await orch.runGitOp({ kind: "create_branch", name: "feature-x" });
    expect(res.ok).toBe(true);
    expect(vcs.calls.gitAdmin).toEqual(["create_branch"]);
  });
});

describe("buildRepoContext (Iris's git awareness)", () => {
  it("summarizes branches (separating Bureau task branches) + recent commits for Iris", () => {
    const ctx = buildRepoContext({
      cloned: true,
      branch: "main",
      branches: ["main", "feature-x", "bureau/task-abc"],
      commits: [{ hash: "abc1234", author: "Gio", date: "2026-06-14", subject: "Cold War README" }],
    });
    expect(ctx).toContain("Checked-out branch: main");
    expect(ctx).toContain("feature-x");
    expect(ctx).toContain("leftover Bureau task branch"); // task branches called out separately
    expect(ctx).toContain("abc1234 Cold War README");
    expect(ctx).toMatch(/can.?t see them/i); // tells Iris she HAS this info (don't claim otherwise)
    expect(ctx).toMatch(/propos\w+ a gitOp/i); // and that admin is done via an inline gitOp, not raw git
  });

  it("flags LOCAL-only branches (exist locally but not on origin) as real — so Iris won't deny them", () => {
    const ctx = buildRepoContext({
      cloned: true,
      branch: "main",
      branches: ["main"], // on GitHub (origin)
      localBranches: ["main", "test", "bureau/task-x"], // local; 'test' is local-only
      commits: [],
    });
    expect(ctx).toMatch(/Local-only branches[^\n]*test/i); // test surfaced as a real local branch
    expect(ctx).toMatch(/do NOT say they don't exist/i);
    expect(ctx).not.toMatch(/Local-only branches[^\n]*bureau\/task-x/); // leftover task branches excluded
  });

  it("is empty when the repo isn't cloned", () => {
    expect(buildRepoContext({ cloned: false, branch: null, branches: [], commits: [] })).toBe("");
  });
});

describe("gitInfo (read-only console)", () => {
  it("syncs the clone to live origin, then returns the repo view with project meta", async () => {
    const info = await orch.gitInfo();
    expect(vcs.calls.syncClone).toBe(1); // shows the LIVE repo, not a stale clone
    expect(info).toMatchObject({ owner: "acme", name: "widget", baseBranch: "main", branch: "main", cloned: true });
    expect(info.commits[0]!.subject).toBe("Initial commit");
    expect(info.branches).toEqual(["main"]);
  });
});

// ── conversations ────────────────────────────────────────────────────────────

describe("conversations", () => {
  it("chat creates a thread, titles it from the first message, and returns its id", async () => {
    const res = await orch.chat("add a quick start to the readme");
    expect(res.conversationId).toBeTruthy();
    expect(res.reply.conversationId).toBe(res.conversationId);
    const convs = orch.listConversations();
    expect(convs).toHaveLength(1);
    expect(convs[0]!.title.toLowerCase()).toContain("add a quick start");
  });

  it("appends to an existing thread when given its id, and isolates threads", async () => {
    const a = await orch.chat("hello");
    const b = await orch.chat("again", undefined, a.conversationId);
    expect(b.conversationId).toBe(a.conversationId);
    expect(orch.listConversations()).toHaveLength(1);
    expect(orch.messagesFor(a.conversationId)).toHaveLength(4); // 2 turns × (user + iris)

    const other = await orch.chat("a different topic"); // no id → new thread
    expect(other.conversationId).not.toBe(a.conversationId);
    expect(orch.listConversations()).toHaveLength(2);
    expect(orch.messagesFor(other.conversationId)).toHaveLength(2);
  });

  it("createConversation makes an empty thread; delete removes it", () => {
    const c = orch.createConversation();
    expect(orch.listConversations().map((x) => x.id)).toContain(c.id);
    expect(orch.messagesFor(c.id)).toHaveLength(0);
    orch.deleteConversation(c.id);
    expect(orch.listConversations().map((x) => x.id)).not.toContain(c.id);
  });
});

// ── createTask ─────────────────────────────────────────────────────────────

describe("createTask", () => {
  it("materializes a DRAFT task (created, not started) in the active project, with a pr_approval gate", () => {
    const task = orch.createTask(PROPOSAL);
    expect(task.status).toBe("created");
    expect(task.goal).toBe(PROPOSAL.title);
    expect(task.projectId).toBe("widget");
    expect(task.repoOwner).toBe("acme");
    expect(task.repoName).toBe("widget");
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0]!.gateAfter).toBe(task.gates[0]!.id);
    expect(task.gates[0]!.kind).toBe("pr_approval");
    expect(vcs.calls.ensureClone).toBe(0); // not started
    expect(toTaskDetail(task).steps[0]!.assignee).toBe("Editor");
  });
});

// ── startTask ──────────────────────────────────────────────────────────────

describe("startTask", () => {
  it("returns immediately (planning), then runs the pipeline and commits LOCALLY without pushing", async () => {
    const draft = orch.createTask(PROPOSAL);
    const immediate = await orch.startTask(draft.id);
    expect(immediate.status).toBe("planning"); // returns before the pipeline runs

    await orch.settle(draft.id);
    const task = store.load(draft.id)!;

    expect(task.status).toBe("awaiting_human");
    expect(captured?.step.capability).toBe("edit");
    expect(vcs.calls.commitAll).toHaveLength(1);
    // The wall is closed: nothing pushed/opened/merged before the CEO confirms.
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.openPr).toHaveLength(0);
    expect(vcs.calls.mergePr).toHaveLength(0);
    expect(canPush(task)).toBe(false);
    expect(toTaskDetail(task).diff).toBe("DIFF-CONTENT");
  });

  it("emits step + gate events as the pipeline runs", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
    expect(types).toContain("gate_opened");
  });

  it("rejects starting a task that isn't a draft", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await expect(orch.startTask(draft.id)).rejects.toMatchObject({ status: 409 });
    await orch.settle(draft.id);
  });
});

// ── confirmMerge — the security wall ─────────────────────────────────────────

describe("confirmMerge", () => {
  it("pushes, opens the PR, and squash-merges exactly once — only after canPush", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    expect(canPush(store.load(draft.id)!)).toBe(false); // parked at an OPEN gate

    const merged = await orch.confirmMerge(draft.id);

    expect(merged.status).toBe("completed");
    expect(canPush(merged)).toBe(true);
    expect(vcs.calls.push).toHaveLength(1);
    expect(vcs.calls.openPr).toHaveLength(1);
    expect(vcs.calls.mergePr).toHaveLength(1);
    expect(vcs.calls.mergePr[0]!.branch).toBe(`bureau/task-${draft.id}`);
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true); // cleaned up
  });

  it("throws 409 when there is no open review gate", async () => {
    const draft = orch.createTask(PROPOSAL);
    await expect(orch.confirmMerge(draft.id)).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.push).toHaveLength(0);
  });
});

// ── openPrForReview — push + open a PR, but NOT merge (the "test branch on GitHub") ──

describe("openPrForReview", () => {
  it("pushes + opens the PR but NEVER merges; the task reads PR-open, not merged", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    expect(canPush(store.load(draft.id)!)).toBe(false); // parked at an OPEN gate

    const result = await orch.openPrForReview(draft.id);

    expect(result.status).toBe("completed");
    expect(canPush(result)).toBe(true); // same wall as a merge — the gate authorized the push
    expect(vcs.calls.push).toHaveLength(1);
    expect(vcs.calls.openPr).toHaveLength(1);
    expect(vcs.calls.mergePr).toHaveLength(0); // ← the whole point: nothing merged to main
    expect(isMerged(result)).toBe(false);
    expect(prOpen(result)).toBe(true);
    expect(result.artifacts.some((a) => a.kind === "pr_open")).toBe(true);
    expect(result.artifacts.some((a) => a.kind === "pr_url")).toBe(false);
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true); // local worktree released
  });

  it("throws 409 when there is no open review gate (nothing pushed)", async () => {
    const draft = orch.createTask(PROPOSAL);
    await expect(orch.openPrForReview(draft.id)).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.push).toHaveLength(0);
  });
});

// ── mergeOpenPr — the deferred merge of an already-open PR (finish from Bureau) ──

describe("mergeOpenPr", () => {
  it("squash-merges a previously opened PR; the task then reads merged, not PR-open", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    await orch.openPrForReview(draft.id); // → completed + PR open, not merged
    expect(prOpen(store.load(draft.id)!)).toBe(true);

    const merged = await orch.mergeOpenPr(draft.id);

    expect(vcs.calls.mergePr).toHaveLength(1); // the deferred merge runs (canPush held)
    expect(isMerged(merged)).toBe(true);
    expect(prOpen(merged)).toBe(false);
  });

  it("throws 409 when the task has no open PR to merge", async () => {
    const draft = orch.createTask(PROPOSAL);
    await expect(orch.mergeOpenPr(draft.id)).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.mergePr).toHaveLength(0);
  });

  it("is idempotent — a 2nd merge of an already-merged task is a no-op (no false error)", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    await orch.openPrForReview(draft.id);
    await orch.mergeOpenPr(draft.id); // merges
    const again = await orch.mergeOpenPr(draft.id); // already merged → returns as-is

    expect(vcs.calls.mergePr).toHaveLength(1); // NOT merged twice
    expect(isMerged(again)).toBe(true);
    expect(again.artifacts.filter((a) => a.kind === "merge_error")).toHaveLength(0); // no false error
  });
});

// ── decideGate — the review loop (approve / request_changes / reject) ─────────

describe("decideGate", () => {
  async function park() {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id); // parked at the open gate (awaiting_human)
    return draft;
  }

  it("request_changes re-runs the pipeline with the CEO's notes, pushes NOTHING, and re-opens the gate", async () => {
    const draft = await park();
    captured = null;

    await orch.decideGate(draft.id, "request_changes", "rename the function to addNumbers");
    await orch.settle(draft.id); // let the background re-run finish

    expect(captured?.context).toContain("rename the function to addNumbers"); // notes reached the worker
    expect(vcs.calls.branchDiff).toBe(1); // cumulative diff captured for re-review
    expect(vcs.calls.push).toHaveLength(0); // ← the wall held: nothing reached GitHub
    const t = store.load(draft.id)!;
    expect(t.status).toBe("awaiting_human"); // parked again for a fresh review
    expect(t.gates[0]!.status).toBe("open");

    // THEN approving merges exactly once — only after the post-re-run approve.
    await orch.decideGate(draft.id, "approved");
    expect(vcs.calls.push).toHaveLength(1);
    expect(vcs.calls.mergePr).toHaveLength(1);
  });

  it("request_changes with blank notes is rejected (400), no re-run", async () => {
    const draft = await park();
    await expect(orch.decideGate(draft.id, "request_changes", "   ")).rejects.toMatchObject({ status: 400 });
    expect(store.load(draft.id)!.status).toBe("awaiting_human"); // unchanged
    expect(vcs.calls.push).toHaveLength(0);
  });

  it("a re-run that makes no change re-opens the gate on the unchanged diff (keeps the work), pushes nothing", async () => {
    const draft = await park();
    vcs.setCommitted(false); // the revision commits nothing
    await orch.decideGate(draft.id, "request_changes", "do nothing useful");
    await orch.settle(draft.id);
    const t = store.load(draft.id)!;
    expect(t.status).toBe("awaiting_human"); // re-opened, NOT aborted — the v1 work survives
    expect(t.gates[0]!.status).toBe("open");
    expect(vcs.calls.push).toHaveLength(0);
  });

  it("reject aborts the task, tears down the worktree, and pushes nothing", async () => {
    const draft = await park();
    const t = await orch.decideGate(draft.id, "rejected");
    expect(t.status).toBe("aborted");
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.mergePr).toHaveLength(0);
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true);
  });

  it("approve routes to confirmMerge (the single push path)", async () => {
    const draft = await park();
    await orch.decideGate(draft.id, "approved");
    expect(vcs.calls.push).toHaveLength(1);
    expect(vcs.calls.openPr).toHaveLength(1);
    expect(vcs.calls.mergePr).toHaveLength(1);
  });

  it("throws 409 when there is no open gate", async () => {
    const draft = orch.createTask(PROPOSAL); // never started → no open gate
    await expect(orch.decideGate(draft.id, "approved")).rejects.toMatchObject({ status: 409 });
  });

  it("re-runs the test step on a request-changes revision and re-notifies on a fresh ✗", async () => {
    const proposal: TaskProposal = {
      title: "Edit then test",
      summary: "x",
      steps: [
        { capability: "edit", description: "make the change" },
        { capability: "test", description: "run the tests" },
      ],
    };
    const draft = orch.createTask(proposal);
    await orch.startTask(draft.id);
    await orch.settle(draft.id); // first run (tests pass)
    testInput = null;
    testSummary = "✗ Tests FAILED — `npm test` exited 1."; // the revision breaks the suite

    await orch.decideGate(draft.id, "request_changes", "tweak it");
    await orch.settle(draft.id);

    expect(testInput?.testCommand).toEqual(["npm", "test"]); // the test ran again on the re-run
    expect(store.load(draft.id)!.status).toBe("awaiting_human"); // still advisory — parks for review
    expect(notifs.items.filter((n) => n.subject === "Tests failed" && n.taskId === draft.id).length).toBeGreaterThan(0);
    expect(vcs.calls.push).toHaveLength(0); // nothing pushed across the loop
  });

  it("a successful merge is reported as merged with the PR url and no merge error", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    await orch.confirmMerge(draft.id);

    const detail = toTaskDetail(store.load(draft.id)!);
    expect(detail.merged).toBe(true);
    expect(detail.mergeError).toBeNull();
    expect(detail.prUrl).toBe("https://github.com/acme/widget/pull/1");
  });

  it("notifies the CEO when a task parks for review and again when it merges", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    expect(notifs.items.some((nft) => nft.kind === "review" && nft.taskId === draft.id)).toBe(true);

    await orch.confirmMerge(draft.id);
    expect(notifs.items.some((nft) => nft.kind === "merged" && nft.taskId === draft.id)).toBe(true);
    expect(orch.unreadNotifications()).toBeGreaterThan(0);
  });

  it("passes the project's configured test command to a test step + parks for review (test makes no diff)", async () => {
    const proposal: TaskProposal = {
      title: "Edit then test",
      summary: "make a change and run the suite",
      steps: [
        { capability: "edit", description: "make the change" },
        { capability: "test", description: "run the tests" },
      ],
    };
    const draft = orch.createTask(proposal);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    expect(testInput?.testCommand).toEqual(["npm", "test"]); // the CEO-configured argv
    const t = store.load(draft.id)!;
    expect(t.status).toBe("awaiting_human"); // a passing test still parks for the human (advisory)
    expect(vcs.calls.push).toHaveLength(0); // and pushes nothing
  });

  it("a ✗ test result is advisory — the task still parks for review and fires a 'Tests failed' notification, never blocks", async () => {
    testSummary = "✗ Tests FAILED — `npm test` exited 1.\n1 failing";
    const proposal: TaskProposal = {
      title: "Edit then failing test",
      summary: "x",
      steps: [
        { capability: "edit", description: "make the change" },
        { capability: "test", description: "run the tests" },
      ],
    };
    const draft = orch.createTask(proposal);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    expect(store.load(draft.id)!.status).toBe("awaiting_human"); // NOT aborted — the human still decides
    expect(notifs.items.some((n) => n.subject === "Tests failed" && n.taskId === draft.id)).toBe(true);
  });

  it("threads an earlier step's summary into a later step's context (plan → edit)", async () => {
    const proposal: TaskProposal = {
      title: "Plan then edit",
      summary: "plan the change, then make it",
      steps: [
        { capability: "plan", description: "plan the change" },
        { capability: "edit", description: "make the change" },
      ],
    };
    const draft = orch.createTask(proposal);
    captured = null;
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    // the edit step (captured last) saw the planner's plan in its context
    expect(captured?.context).toContain("PLAN: edit README.md and add a Status section.");
    expect(captured?.context).toContain("Planner"); // labelled by persona
  });

  it("hands a review step the current diff and persists its verdict as the step summary", async () => {
    const proposal: TaskProposal = {
      title: "Edit then review",
      summary: "make a change and check it",
      steps: [
        { capability: "edit", description: "make the change" },
        { capability: "review", description: "check the change before merge" },
      ],
    };
    const draft = orch.createTask(proposal);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    expect(reviewInput?.diff).toBe("REVIEW-DIFF-CONTENT"); // the full change vs base
    const detail = toTaskDetail(store.load(draft.id)!);
    const reviewStep = detail.steps.find((s) => s.capability === "review")!;
    expect(reviewStep.summary).toBe("Looks good.");
  });

  it("streams the worker's output (step_progress) and persists its summary on the step", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    const progress = events.filter((e) => e.type === "step_progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toMatchObject({ type: "step_progress", taskId: draft.id, capability: "edit" });
    expect((progress[0] as { chunk: string }).chunk).toContain("Added a Status section.");

    const detail = toTaskDetail(store.load(draft.id)!);
    expect(detail.steps[0]!.summary).toBe("Added a Status section.");
  });

  it("records token usage for each worker step (scoped to the capability + task)", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    const editEvents = usage.events.filter((e) => e.scope === "edit");
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0]).toMatchObject({ scope: "edit", taskId: draft.id, model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 200 });
    expect(editEvents[0]!.day).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it("writes a task journal to System Memory on merge", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    await orch.confirmMerge(draft.id);

    expect(mem.journals).toHaveLength(1);
    expect(mem.journals[0]!.path).toMatch(/^journals\/.*\.md$/);
    expect(mem.journals[0]!.markdown).toContain(draft.goal);
    expect(mem.journals[0]!.markdown).toContain("Merged to main");
    // The worker's report is persisted in full — the deliverable, not just metadata.
    expect(mem.journals[0]!.markdown).toContain("## Reports");
    expect(mem.journals[0]!.markdown).toContain("Added a Status section.");
  });

  it("records an honest merge error (and keeps the PR link) when the squash-merge fails — never a false 'merged'", async () => {
    vcs.setMergeError("merge conflict in README.md");
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    const task = await orch.confirmMerge(draft.id);
    // The PR was opened, so the merge was attempted (the wall opened) …
    expect(vcs.calls.openPr).toHaveLength(1);
    expect(vcs.calls.mergePr).toHaveLength(1);
    // … but it didn't land: the task is honest about it.
    const detail = toTaskDetail(task);
    expect(detail.merged).toBe(false);
    expect(detail.mergeError).toBe("merge conflict in README.md");
    expect(detail.prUrl).toBe("https://github.com/acme/widget/pull/1"); // link to resolve
    expect(prOpen(task)).toBe(true); // pr_open recorded BEFORE mergePr → the CEO keeps the "Merge to main" retry
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true); // still cleaned up
  });

  it("on an EMPTY repo the first task ESTABLISHES main (no PR) — never the 'base can't be blank' failure", async () => {
    vcs.setBaseEmpty(true); // origin has no base branch yet (brand-new repo)
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    const detail = toTaskDetail(await orch.confirmMerge(draft.id));
    expect(vcs.calls.push).toHaveLength(0); // the task branch is NOT pushed first (it'd become origin's default)
    expect(vcs.calls.openPr).toHaveLength(0); // NO PR attempted — there was no base to target
    expect(vcs.calls.establishBase).toHaveLength(1); // main established straight from the worktree branch
    expect(vcs.calls.establishBase[0]!.fromOrigin).toBe(false);
    expect(vcs.calls.setDefaultBranch).toBe(1); // the default is pinned to main
    expect(detail.merged).toBe(true); // the work genuinely landed on main
    expect(detail.prUrl).toBeNull(); // …with NO fabricated PR link
    expect(detail.mergeError).toBeNull();
  });
});

// ── establishBaseForTask (recovery) ──────────────────────────────────────────

describe("establishBaseForTask", () => {
  it("lands a task that earlier FAILED on an empty repo — from origin, idempotent, behind the wall", async () => {
    // Simulate the original failure: empty repo + the land throws once.
    vcs.setBaseEmpty(true);
    vcs.setMergeError("pull request create failed: GraphQL: can't be blank");
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    let detail = toTaskDetail(await orch.confirmMerge(draft.id));
    expect(detail.merged).toBe(false); // it didn't land
    expect(detail.mergeError).not.toBeNull(); // honest failure recorded

    // Recover: the worktree is gone, so establish the base from the pushed branch on origin.
    vcs.setMergeError(null);
    await orch.establishBaseForTask(draft.id);
    expect(vcs.calls.establishBase.some((c) => c.fromOrigin)).toBe(true); // ran from origin, not a worktree
    detail = toTaskDetail(store.load(draft.id)!);
    expect(detail.merged).toBe(true); // landed
    expect(detail.prUrl).toBeNull();
    expect(detail.mergeError).toBeNull(); // the stale error is suppressed once landed

    // Idempotent — a second call is a no-op (already merged), records no new error.
    const before = vcs.calls.establishBase.length;
    await orch.establishBaseForTask(draft.id);
    expect(vcs.calls.establishBase).toHaveLength(before);
  });

  it("refuses to land a task that isn't authorized to push (the wall holds)", async () => {
    const draft = orch.createTask(PROPOSAL); // created, never run/approved → canPush() false
    await expect(orch.establishBaseForTask(draft.id)).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.establishBase).toHaveLength(0);
  });

  it("if a base APPEARED, records pr_open BEFORE mergePr — a mergePr failure routes to the PR retry, never a re-open loop", async () => {
    vcs.setBaseEmpty(true);
    vcs.setMergeError("first land failed");
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    await orch.confirmMerge(draft.id); // fails on the empty repo (establishBase throws)

    // A base appeared meanwhile (another task initialized the repo), but the squash-merge now fails.
    vcs.setBaseEmpty(false);
    vcs.setMergeError("merge blocked");
    await orch.establishBaseForTask(draft.id);

    let detail = toTaskDetail(store.load(draft.id)!);
    expect(vcs.calls.openPr).toHaveLength(1); // a PR was opened against the now-existing base
    expect(detail.prOpen).toBe(true); // recorded pr_open → NOT a dead end
    expect(detail.merged).toBe(false);

    // establishBaseForTask now REFUSES (the open PR must be merged via mergeOpenPr) — no re-open loop.
    await expect(orch.establishBaseForTask(draft.id)).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.openPr).toHaveLength(1); // openPr NOT called a second time

    // The in-Bureau "Merge to main" retry lands it.
    vcs.setMergeError(null);
    await orch.mergeOpenPr(draft.id);
    detail = toTaskDetail(store.load(draft.id)!);
    expect(detail.merged).toBe(true);
  });
});

// ── stopTask ─────────────────────────────────────────────────────────────────

describe("stopTask", () => {
  it("aborts a parked task and force-removes its worktree, never pushing", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id); // parked at review, worktree set

    const stopped = await orch.stopTask(draft.id);

    expect(stopped.status).toBe("aborted");
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true);
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.mergePr).toHaveLength(0);
  });

  it("a stop while a step is running aborts the task and never commits or pushes", async () => {
    let release!: () => void;
    editGate = new Promise<void>((r) => (release = r));

    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await until(() => store.load(draft.id)!.status === "executing"); // pipeline is mid-step

    const stopped = await orch.stopTask(draft.id);
    expect(stopped.status).toBe("aborted");

    release(); // unblock the capability — the runner must notice the abort and bail
    await orch.settle(draft.id);

    expect(store.load(draft.id)!.status).toBe("aborted");
    expect(vcs.calls.commitAll).toHaveLength(0); // never reached the commit
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.mergePr).toHaveLength(0);
  });

  it("is idempotent — stopping a completed task leaves it completed", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id);
    await orch.confirmMerge(draft.id); // → completed
    const stopped = await orch.stopTask(draft.id);
    expect(stopped.status).toBe("completed");
  });

  it("throws 404 for an unknown task", async () => {
    await expect(orch.stopTask("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleteTask", () => {
  it("deletes a created (never-started) task without touching any worktree", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.deleteTask(draft.id);
    expect(store.load(draft.id)).toBeNull();
    expect(vcs.calls.removeWorktree).toHaveLength(0); // nothing was ever set up
    expect(events.some((e) => e.type === "task_updated" && e.taskId === draft.id)).toBe(true);
  });

  it("deletes a task parked at the review gate and tears down its worktree", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await orch.settle(draft.id); // parked at the gate (awaiting_human)
    expect(store.load(draft.id)!.status).toBe("awaiting_human");

    await orch.deleteTask(draft.id);
    expect(store.load(draft.id)).toBeNull();
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true);
    expect(vcs.calls.push).toHaveLength(0); // deleting never reaches GitHub
  });

  it("deletes a RUNNING task only after its worktree is torn down (no orphan, no push)", async () => {
    let release!: () => void;
    editGate = new Promise<void>((r) => (release = r));

    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await until(() => store.load(draft.id)!.status === "executing"); // frozen mid-step

    const del = orch.deleteTask(draft.id); // stops, settles, tears down, removes — in order
    release(); // unblock the frozen step so the pipeline can settle
    await del;

    expect(store.load(draft.id)).toBeNull(); // record gone
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true); // worktree torn down (awaited)
    expect(vcs.calls.push).toHaveLength(0); // never pushed
    expect(vcs.calls.commitAll).toHaveLength(0); // aborted before commit
  });

  it("throws 404 for an unknown task", async () => {
    await expect(orch.deleteTask("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("read-only task (no mutating step)", () => {
  it("completes a review-only task with the worker's report — never aborts as 'no changes'", async () => {
    const draft = orch.createTask({ title: "Verify state", summary: "inspect only", steps: [{ capability: "review", description: "Inspect the repo." }] });
    expect(draft.gates).toHaveLength(0); // no review-and-merge gate for a read-only task

    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    const final = store.load(draft.id)!;
    expect(final.status).toBe("completed"); // completed, NOT aborted
    expect(final.steps[0]!.status).toBe("completed"); // the review step ran + completed (not blocked_on_gate)
    expect(vcs.calls.commitAll).toHaveLength(0); // nothing to commit
    expect(vcs.calls.push).toHaveLength(0); // canPush untouched — nothing pushed

    // A read-only task's report IS the deliverable — it must land in the Memory journal
    // (there's no commit/PR/branch carrying it). This is the exact path the fix restores.
    expect(mem.journals).toHaveLength(1);
    expect(mem.journals[0]!.markdown).toContain("## Reports");
    expect(mem.journals[0]!.markdown).toContain("Looks good.");
  });
});

// ── integrity & recovery ─────────────────────────────────────────────────────

describe("capability integrity", () => {
  it("rejects creating a task whose capability isn't registered (no silent no-op)", () => {
    expect(() =>
      orch.createTask({ title: "T", summary: "S", steps: [{ capability: "document", description: "d" }] })
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("fails LOUD (aborts, step failed, no commit) if a step's capability is unregistered at run time", async () => {
    const draft = orch.createTask(PROPOSAL); // valid edit step
    // Tamper past createTask's guard: swap to an unregistered capability in the store
    // ("document" is not registered in this harness; edit/review/plan/test are).
    const t = store.load(draft.id)!;
    store.save({ ...t, steps: t.steps.map((s) => ({ ...s, capability: "document" as const })) });

    await orch.startTask(draft.id);
    await orch.settle(draft.id);

    const final = store.load(draft.id)!;
    expect(final.status).toBe("aborted");
    expect(final.steps[0]!.status).toBe("failed");
    expect(vcs.calls.commitAll).toHaveLength(0); // never committed a no-op
  });
});

describe("reconcile (crash recovery)", () => {
  it("marks tasks left mid-flight by a crash as interrupted, KEEPING their worktree for resume", async () => {
    const draft = orch.createTask(PROPOSAL);
    // Simulate a hard crash: persist it executing (a step running) with a worktree, no live pipeline.
    const t = store.load(draft.id)!;
    store.save({
      ...t,
      status: "executing",
      worktreePath: "/wt/zombie",
      steps: t.steps.map((s, i) => (i === 0 ? { ...s, status: "running" as const } : s)),
    });

    const cleaned = await orch.reconcile();

    expect(cleaned).toBe(1);
    expect(store.load(draft.id)!.status).toBe("interrupted");
    expect(store.load(draft.id)!.steps[0]!.status).toBe("pending"); // the in-flight step is reset
    expect(vcs.calls.removeWorktree).toHaveLength(0); // worktree preserved (not torn down)
  });

  it("leaves terminal/draft tasks untouched", async () => {
    orch.createTask(PROPOSAL); // created (draft)
    const cleaned = await orch.reconcile();
    expect(cleaned).toBe(0);
  });
});

describe("verify loop (closed-loop auto-fix)", () => {
  type Runner = () => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>;

  /** Build an orchestrator with a custom edit capability, vcs, and verify-command runner. The
   *  edit capability bumps `version`; the vcs diff reflects it so the no-progress guard only
   *  fires when an edit genuinely changes nothing. */
  function setup(opts: { runner: Runner; changingDiff?: boolean; project?: ProjectConfig; editThrows?: number }) {
    const counters = { edits: 0, version: 0, verifyRuns: 0, reviewSawEdits: -1 };
    const reg = new CapabilityRegistry();
    reg.register({
      kind: "edit",
      async execute(input) {
        counters.edits++;
        counters.version++;
        if (opts.editThrows === counters.edits) throw new Error("re-edit boom"); // simulate a verify-phase fix throwing
        input.onChunk?.(`edit ${counters.edits}`);
        return { artifacts: [], summary: `edit ${counters.edits}`, usage: { inputTokens: 100, outputTokens: 50, model: "claude-opus-4-8" } };
      },
    });
    reg.register({
      kind: "review",
      // Records how many edits had run by the time review assessed the change — so a test can
      // prove review sees VERIFIED (post-fix) code, not the pre-fix diff.
      async execute() {
        counters.reviewSawEdits = counters.edits;
        return { artifacts: [], summary: "Looks good." };
      },
    });
    const v = fakeVcs();
    if (opts.changingDiff) v.vcs.workingDiff = async () => `diff-v${counters.version}`; // changes per edit
    const runner: Runner = async () => {
      counters.verifyRuns++;
      return opts.runner();
    };
    let n = 0;
    const o = new Orchestrator({
      store,
      capabilities: reg,
      provider: prov.provider,
      projects: new ProjectRegistry([opts.project ?? PROJECT]),
      projectRepo,
      reposRoot: "/repos",
      vcs: () => v.vcs,
      events: { emit: () => {} },
      messages: fakeMessages(),
      conversations: fakeConversations(),
      memory: mem.memory,
      usage: usage.usage,
      notifications: notifs.store,
      commandRunner: runner,
      ids: () => `vf-${++n}`,
      clock: () => "2026-06-13T00:00:00.000Z",
    });
    return { o, v, counters };
  }

  const EDIT_ONLY: TaskProposal = { title: "verify me", summary: "x", steps: [{ capability: "edit", description: "do it" }] };

  it("re-edits to fix a failing check, then lands at the gate with a verified diff (one commit, no push)", async () => {
    // Fail until a fix has run (version ≥ 2), then pass.
    const { o, v, counters } = setup({
      changingDiff: true,
      runner: async () =>
        counters.version >= 2
          ? { stdout: "ok", stderr: "", code: 0, timedOut: false }
          : { stdout: "boom", stderr: "TypeError: key={turn()}", code: 1, timedOut: false },
    });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    const task = store.load(draft.id)!;
    expect(task.status).toBe("awaiting_human"); // parked at the gate, NOT aborted
    expect(counters.edits).toBe(2); // initial edit + ONE fix re-edit
    expect(counters.verifyRuns).toBe(2); // failed once, then passed
    expect(v.calls.commitAll).toHaveLength(1); // exactly one commit — the verified diff
    expect(v.calls.push).toHaveLength(0); // the wall held — nothing reached GitHub
    expect(usage.events.filter((e) => e.scope === "edit" && e.taskId === draft.id)).toHaveLength(2); // fix billed
  });

  it("lands at the gate (never aborts) and notifies when checks keep failing past the attempt budget", async () => {
    const { o, v, counters } = setup({ changingDiff: true, runner: async () => ({ stdout: "still broken", stderr: "err", code: 1, timedOut: false }) });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    const task = store.load(draft.id)!;
    expect(task.status).toBe("awaiting_human"); // the human still decides — work is never discarded
    expect(v.calls.commitAll).toHaveLength(1);
    expect(v.calls.push).toHaveLength(0);
    expect(counters.edits).toBe(3); // initial + 2 fix attempts (VERIFY_MAX_FIX_ATTEMPTS=2)
    expect(notifs.items.some((nf) => nf.subject === "Checks still failing" && nf.taskId === draft.id)).toBe(true);
  });

  it("stops early (no-progress guard) when a fix changes nothing", async () => {
    // changingDiff:false → the vcs diff is constant, so a fix that the worker 'made' looks identical.
    const { o, v, counters } = setup({ changingDiff: false, runner: async () => ({ stdout: "broken", stderr: "err", code: 1, timedOut: false }) });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    const task = store.load(draft.id)!;
    expect(task.status).toBe("awaiting_human");
    expect(counters.edits).toBe(2); // initial + ONE fix; identical diff ⇒ stop (not the full budget)
    expect(notifs.items.some((nf) => nf.subject === "Checks failing (no fix)" && nf.taskId === draft.id)).toBe(true);
  });

  it("surfaces a check that can't run as a config problem without burning fix attempts", async () => {
    const { o, v, counters } = setup({ changingDiff: true, runner: async () => ({ stdout: "", stderr: "spawn ENOENT", code: -1, timedOut: false }) });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    const task = store.load(draft.id)!;
    expect(task.status).toBe("awaiting_human");
    expect(counters.edits).toBe(1); // no re-edit — a missing binary isn't a code bug
    expect(counters.verifyRuns).toBe(1);
    expect(v.calls.commitAll).toHaveLength(1);
    expect(notifs.items.some((nf) => nf.subject === "Couldn't run the checks" && nf.taskId === draft.id)).toBe(true);
  });

  it("skips verify entirely when the project has no command configured", async () => {
    const noCmd: ProjectConfig = { id: "nocmd", owner: "acme", name: "bare", url: "u", baseBranch: "main", canonicalPath: "/n/repo", worktreesDir: "/n/wt" };
    let called = 0;
    const { o, v } = setup({ project: noCmd, changingDiff: true, runner: async () => (called++, { stdout: "", stderr: "", code: 0, timedOut: false }) });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    expect(called).toBe(0); // the runner was never invoked — no command to run
    expect(store.load(draft.id)!.status).toBe("awaiting_human");
    expect(v.calls.commitAll).toHaveLength(1);
  });

  it("a verify-phase error lands at the gate (preserving the edit), never aborts the task", async () => {
    // Verify always fails → a fix re-edit is triggered; that re-edit THROWS (e.g. a timed-out worker).
    const { o, v } = setup({
      changingDiff: true,
      editThrows: 2, // the initial edit succeeds; the fix re-edit throws
      runner: async () => ({ stdout: "", stderr: "fail", code: 1, timedOut: false }),
    });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    const task = store.load(draft.id)!;
    expect(task.status).toBe("awaiting_human"); // NOT aborted — the completed edit survives for review
    expect(v.calls.commitAll).toHaveLength(1);
    expect(task.artifacts.find((a) => a.kind === "report")?.ref).toContain("errored"); // honest status
  });

  it("runs verify BEFORE a later review step — the reviewer assesses VERIFIED code, not the pre-fix diff", async () => {
    // Fail the first verify, pass after one fix re-edit.
    const { o, counters } = setup({
      changingDiff: true,
      runner: async () =>
        counters.version >= 2
          ? { stdout: "ok", stderr: "", code: 0, timedOut: false }
          : { stdout: "boom", stderr: "TypeError", code: 1, timedOut: false },
    });
    const draft = o.createTask({
      title: "edit then review",
      summary: "x",
      steps: [
        { capability: "edit", description: "make the change" },
        { capability: "review", description: "check it before merge" },
      ],
    });
    await o.startTask(draft.id);
    await o.settle(draft.id);

    expect(counters.edits).toBe(2); // initial edit + one verify-driven fix
    expect(counters.reviewSawEdits).toBe(2); // review ran AFTER the fix → it assessed verified code
    expect(store.load(draft.id)!.status).toBe("awaiting_human");
  });

  it("persists an HONEST measured verification status (artifact + PR body) when checks pass", async () => {
    const { o, v } = setup({ changingDiff: true, runner: async () => ({ stdout: "ok", stderr: "", code: 0, timedOut: false }) });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    const task = store.load(draft.id)!;
    const report = task.artifacts.find((a) => a.kind === "report" && a.ref.startsWith("VERIFY::"));
    expect(report?.ref).toContain("✓ Verified"); // measured, not claimed
    await o.confirmMerge(draft.id);
    expect(v.calls.openPr[0]?.body).toContain("✓ Verified"); // the PR body carries the MEASURED status
  });

  it("is HONEST when nothing was verified — never implies a check ran (no command configured)", async () => {
    const noCmd: ProjectConfig = { id: "nc2", owner: "acme", name: "bare2", url: "u", baseBranch: "main", canonicalPath: "/n2/repo", worktreesDir: "/n2/wt" };
    const { o, v } = setup({ project: noCmd, changingDiff: true, runner: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }) });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    const task = store.load(draft.id)!;
    expect(task.artifacts.find((a) => a.kind === "report")?.ref).toContain("Not automatically verified");
    await o.confirmMerge(draft.id);
    expect(v.calls.openPr[0]?.body).toContain("Not automatically verified");
  });

  it("setProjectTestCommand turns the loop on for an existing project (persisted + live)", () => {
    const { o } = setup({ changingDiff: true, runner: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }) });
    const before = o.listProjects().find((p) => p.id === PROJECT.id)!;
    expect(before.testCommand).toEqual(["npm", "test"]); // PROJECT seeds with one
    const dto = o.setProjectTestCommand(PROJECT.id, ["bun", "run", "build"]);
    expect(dto.testCommand).toEqual(["bun", "run", "build"]);
    expect(o.listProjects().find((p) => p.id === PROJECT.id)!.testCommand).toEqual(["bun", "run", "build"]);
    // clearing removes it
    expect(o.setProjectTestCommand(PROJECT.id, undefined).testCommand).toBeUndefined();
  });

  it("setProjectConfig sets the verify LIST + provision override, leaving the test command untouched (persisted + live)", () => {
    const { o } = setup({ changingDiff: true, runner: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }) });
    const dto = o.setProjectConfig(PROJECT.id, {
      verifyCommands: [["pnpm", "build"], ["pnpm", "test"]],
      provisionCommand: ["pnpm", "install"],
    });
    expect(dto.verifyCommands).toEqual([["pnpm", "build"], ["pnpm", "test"]]);
    expect(dto.provisionCommand).toEqual(["pnpm", "install"]);
    expect(dto.testCommand).toEqual(["npm", "test"]); // a verify-only patch leaves the test command alone
    // Live registry reflects it…
    expect(o.listProjects().find((p) => p.id === PROJECT.id)!.verifyCommands).toEqual([["pnpm", "build"], ["pnpm", "test"]]);
    // …and the durable row persists it (nested JSON columns).
    const row = projectRepo.get(PROJECT.id);
    expect(row?.verifyCommands).toEqual([["pnpm", "build"], ["pnpm", "test"]]);
    expect(row?.provisionCommand).toEqual(["pnpm", "install"]);
    // Clearing just the verify list falls back to the test command; the provision override stays.
    const cleared = o.setProjectConfig(PROJECT.id, { verifyCommands: null });
    expect("verifyCommands" in cleared).toBe(false);
    expect(cleared.provisionCommand).toEqual(["pnpm", "install"]);
  });

  it("runs the configured verify LIST in order (not the single test command) and the provision override — through the sandboxed runner", async () => {
    // PROJECT keeps testCommand ["npm","test"]; the verify list must OVERRIDE it for verification.
    const proj: ProjectConfig = {
      ...PROJECT,
      verifyCommands: [["pnpm", "build"], ["pnpm", "test"]],
      provisionCommand: ["pnpm", "install", "--frozen-lockfile"],
    };
    const captured: string[][] = [];
    const reg = new CapabilityRegistry();
    reg.register({
      kind: "edit",
      async execute() {
        return { artifacts: [], summary: "edited", usage: { inputTokens: 1, outputTokens: 1, model: "claude-opus-4-8" } };
      },
    });
    const v = fakeVcs();
    v.vcs.workingDiff = async () => "diff"; // a real change → the gate opens and verify runs
    let n = 0;
    const o = new Orchestrator({
      store,
      capabilities: reg,
      provider: prov.provider,
      projects: new ProjectRegistry([proj]),
      projectRepo,
      reposRoot: "/repos",
      vcs: () => v.vcs,
      events: { emit: () => {} },
      messages: fakeMessages(),
      conversations: fakeConversations(),
      memory: mem.memory,
      usage: usage.usage,
      notifications: notifs.store,
      // Capture every argv the sandboxed runner is handed (provision + each verify command).
      commandRunner: async (command) => {
        captured.push([...command]);
        return { stdout: "ok", stderr: "", code: 0, timedOut: false };
      },
      ids: () => `vc-${++n}`,
      clock: () => "2026-06-13T00:00:00.000Z",
    });
    const draft = o.createTask(EDIT_ONLY);
    await o.startTask(draft.id);
    await o.settle(draft.id);

    expect(captured[0]).toEqual(["pnpm", "install", "--frozen-lockfile"]); // provisioning used the CEO override
    expect(captured.slice(1)).toEqual([["pnpm", "build"], ["pnpm", "test"]]); // verify ran the LIST, in order
    expect(captured).not.toContainEqual(["npm", "test"]); // the single test command was overridden, never run
    const task = store.load(draft.id)!;
    expect(task.status).toBe("awaiting_human");
    // The report is honest about exactly what ran.
    expect(task.artifacts.find((a) => a.kind === "report")?.ref).toContain("pnpm build, pnpm test");
  });
});

describe("chat — project pinning (an existing thread keeps its own project)", () => {
  const Q: ProjectConfig = { id: "q", owner: "other", name: "repo", url: "u-q", baseBranch: "main", canonicalPath: "/q/repo", worktreesDir: "/q/wt" };

  function twoProjectOrch() {
    let n = 0;
    return new Orchestrator({
      store,
      capabilities: new CapabilityRegistry(),
      provider: prov.provider,
      projects: new ProjectRegistry([PROJECT, Q]),
      projectRepo,
      reposRoot: "/repos",
      vcs: () => vcs.vcs,
      events: { emit: () => {} },
      messages: fakeMessages(),
      conversations: fakeConversations(),
      memory: mem.memory,
      usage: usage.usage,
      notifications: notifs.store,
      ids: () => `c-${++n}`,
      clock: () => "2026-06-13T00:00:00.000Z",
    });
  }

  it("reopening a P-thread with the picker on Q feeds Iris P's repo, NOT Q's", async () => {
    const o = twoProjectOrch();
    prov.setReply(JSON.stringify({ reply: "ok" }));
    const first = await o.chat("hi", "widget"); // thread starts on acme/widget
    await o.chat("still here?", "q", first.conversationId); // picker switched to other/repo, SAME thread
    const sys = prov.system();
    expect(sys).toContain("acme/widget"); // pinned to the thread's project
    expect(sys).not.toContain("other/repo"); // never the picker's current project
  });

  it("a brand-new thread uses the requested (picker) project", async () => {
    const o = twoProjectOrch();
    prov.setReply(JSON.stringify({ reply: "ok" }));
    await o.chat("fresh", "q"); // new thread on other/repo
    expect(prov.system()).toContain("other/repo");
  });
});

describe("effort policy (Settings)", () => {
  it("setEfforts validates, applies per scope, clears on '', and surfaces in engineInfo", () => {
    expect(orch.engineInfo().efforts).toEqual({}); // empty by default — model's built-in effort
    orch.setEfforts({ edit: "high", iris: "xhigh" });
    expect(orch.engineInfo().efforts).toEqual({ edit: "high", iris: "xhigh" });
    orch.setEfforts({ edit: "" }); // "" clears a scope back to default
    expect(orch.engineInfo().efforts).toEqual({ iris: "xhigh" });
    expect(() => orch.setEfforts({ edit: "max" })).toThrow(); // 'max' is not selectable
  });

  it("threads the resolved effort into a worker step; omits it when unset", async () => {
    orch.setEfforts({ edit: "high" });
    const a = orch.createTask(PROPOSAL, "widget");
    await orch.startTask(a.id);
    await orch.settle(a.id);
    expect(captured?.effort).toBe("high");

    orch.setEfforts({ edit: "" }); // back to default
    captured = null;
    const b = orch.createTask(PROPOSAL, "widget");
    await orch.startTask(b.id);
    await orch.settle(b.id);
    expect(captured?.effort).toBeUndefined();
  });
});

describe("memory curation (the Archivist)", () => {
  it("curate() returns the Archivist's parsed JSON plan", async () => {
    prov.setReply(JSON.stringify({ summary: "two stale journals", actions: [{ kind: "prune", paths: ["journals/old.md"], reason: "superseded" }] }));
    const plan = await orch.curate();
    expect(plan.summary).toContain("stale");
    expect(plan.actions[0]).toMatchObject({ kind: "prune", paths: ["journals/old.md"] });
  });

  it("curate() degrades to an empty plan on non-JSON output (never throws)", async () => {
    prov.setReply("sorry, I can't do that right now");
    const plan = await orch.curate();
    expect(plan.actions).toEqual([]);
  });

  it("applyCuration archives prune+compact sources, writes the digest, promotes a note, skips audit", async () => {
    const plan = {
      summary: "tidy-up",
      actions: [
        { kind: "prune" as const, paths: ["journals/a.md"], reason: "superseded" },
        { kind: "compact" as const, paths: ["journals/b.md", "journals/c.md"], reason: "merge", digestTitle: "Digest: X (June)", digestBody: "merged outcomes" },
        { kind: "promote" as const, paths: [], reason: "important", noteTitle: "Decision", noteBody: "use X" },
        { kind: "audit" as const, paths: ["notes/z.md"], reason: "maybe stale" },
      ],
    };
    await orch.applyCuration({ plan, accept: [0, 1, 2, 3] });
    expect([...mem.archived].sort()).toEqual(["journals/a.md", "journals/b.md", "journals/c.md"]); // prune + compact sources archived (reversible)
    expect(mem.saved).toContainEqual({ title: "Decision", body: "use X" }); // promote → pinned note
    expect(mem.journals.some((j) => j.markdown.includes("merged outcomes"))).toBe(true); // digest written as a journal
  });

  it("applyCuration applies ONLY the accepted subset", async () => {
    const plan = { summary: "x", actions: [
      { kind: "prune" as const, paths: ["journals/a.md"], reason: "old" },
      { kind: "prune" as const, paths: ["journals/b.md"], reason: "old" },
    ] };
    await orch.applyCuration({ plan, accept: [1] }); // only the second
    expect(mem.archived).toEqual(["journals/b.md"]);
  });

  it("a compact MISSING its digest archives NOTHING (never silently degrades to a destructive prune)", async () => {
    const plan = { summary: "x", actions: [
      { kind: "compact" as const, paths: ["journals/a.md", "journals/b.md"], reason: "merge" }, // no digestTitle/Body
    ] };
    await orch.applyCuration({ plan, accept: [0] });
    expect(mem.archived).toEqual([]); // sources untouched — the action is skipped, not a delete
    expect(mem.journals).toEqual([]); // and no digest written
  });

  it("counts a task journaled on BOTH open-PR and merge only ONCE (no double-count)", async () => {
    const t = orch.createTask(PROPOSAL);
    await orch.startTask(t.id);
    await orch.settle(t.id);
    await orch.openPrForReview(t.id); // journals once (completed, PR open)
    await orch.mergeOpenPr(t.id); // journals AGAIN (merged) — same task, one vault file
    const st = await orch.curationStatus();
    expect(st.tasksSinceCuration).toBe(1); // deduped by task id
  });

  it("tracks finished tasks since curation, doesn't nudge early, and applyCuration re-arms the counter", async () => {
    const t = orch.createTask(PROPOSAL, "widget");
    await orch.startTask(t.id);
    await orch.settle(t.id); // let the pipeline park at the gate
    await orch.stopTask(t.id); // abort a finished task → journaled → counter increments
    let st = await orch.curationStatus();
    expect(st.tasksSinceCuration).toBe(1);
    expect(st.curateEvery).toBe(10);
    expect(events.some((e) => e.type === "curation_due")).toBe(false); // 1 of 10 — no early nudge
    await orch.applyCuration({ plan: { summary: "", actions: [] }, accept: [] });
    st = await orch.curationStatus();
    expect(st.tasksSinceCuration).toBe(0); // re-armed
    expect(st.lastCuratedAt).not.toBeNull();
  });
});

describe("step hard-cap backstop", () => {
  it("kills a worker whose promise NEVER settles, and aborts the task", async () => {
    // The CLI watchdog reaps a hung subprocess; this orchestrator backstop only catches a
    // worker PROMISE that never settles (a buggy/non-CLI provider). Inject a tiny cap to exercise it.
    const reg = new CapabilityRegistry();
    reg.register({ kind: "edit", execute: () => new Promise(() => {}) }); // never resolves
    let n = 0;
    const o = new Orchestrator({
      store,
      capabilities: reg,
      provider: prov.provider,
      projects: new ProjectRegistry([PROJECT]),
      projectRepo,
      reposRoot: "/repos",
      vcs: () => vcs.vcs,
      events: { emit: () => {} },
      messages: fakeMessages(),
      conversations: fakeConversations(),
      memory: mem.memory,
      usage: usage.usage,
      notifications: notifs.store,
      stepHardCapMs: 25, // fires fast
      ids: () => `hc-${++n}`,
      clock: () => "2026-06-13T00:00:00.000Z",
    });
    const draft = o.createTask(PROPOSAL, "widget");
    await o.startTask(draft.id);
    await o.settle(draft.id);
    const final = store.load(draft.id)!;
    expect(final.status).toBe("aborted");
    expect(final.steps[0]!.status).toBe("failed");
  });

  it("the default hard cap clears the worst legitimate CLI step (2 idle-kills + 1 ceiling-kill)", () => {
    // The backstop must never pre-empt a real retrying CLI step. Worst case = 2×idle + 1×ceiling
    // (ceiling is permanent → no 3×ceiling). The orchestrator's default hard cap is 4_500_000 (75min).
    expect(4_500_000).toBeGreaterThan(DEFAULT_CLI_CEILING_MS + 2 * DEFAULT_CLI_IDLE_MS); // 75min > 70min
  });

  it("a non-positive injected hard cap falls back to the default — NOT a 1ms cap that kills every step", async () => {
    const reg = new CapabilityRegistry();
    reg.register({
      kind: "edit",
      async execute() {
        await new Promise((r) => setTimeout(r, 20)); // takes 20ms — a buggy 1ms cap would kill it
        return { artifacts: [], summary: "done", usage: { inputTokens: 1, outputTokens: 1, model: "claude-opus-4-8" } };
      },
    });
    let n = 0;
    const o = new Orchestrator({
      store,
      capabilities: reg,
      provider: prov.provider,
      projects: new ProjectRegistry([PROJECT]),
      projectRepo,
      reposRoot: "/repos",
      vcs: () => vcs.vcs,
      events: { emit: () => {} },
      messages: fakeMessages(),
      conversations: fakeConversations(),
      memory: mem.memory,
      usage: usage.usage,
      notifications: notifs.store,
      stepHardCapMs: 0, // must NOT become Math.max(1,0)=1 — falls back to the 75-min default
      ids: () => `z-${++n}`,
      clock: () => "2026-06-13T00:00:00.000Z",
    });
    const draft = o.createTask(PROPOSAL, "widget");
    await o.startTask(draft.id);
    await o.settle(draft.id);
    const final = store.load(draft.id)!;
    expect(final.status).not.toBe("aborted"); // a 1ms cap would have aborted it
    expect(final.steps[0]!.status).not.toBe("failed"); // the 20ms edit ran (parked at the gate), not killed
  });
});
