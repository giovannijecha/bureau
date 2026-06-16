import { describe, it, expect, beforeEach } from "vitest";

import { canPush } from "@bureau/core";
import type { Task } from "@bureau/core";
import { CapabilityRegistry } from "@bureau/capabilities";
import type { CapabilityInput } from "@bureau/capabilities";
import type { Provider } from "@bureau/providers";
import type { WsEvent, Message, TaskProposal, Conversation } from "@bureau/contracts";

import { Orchestrator, buildRepoContext } from "../src/orchestrator.js";
import { ProjectRegistry, type ProjectConfig } from "../src/projects.js";
import type { TaskStore, VcsPort, MessageLog, ConversationStore, MemoryPort, UsagePort, UsageEvent, NotificationStore } from "../src/ports.js";
import type { Notification } from "@bureau/contracts";
import { toTaskDetail } from "../src/summary.js";

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
    commitAll: [] as { path: string; message: string }[],
    push: [] as { path: string; branch: string }[],
    openPr: [] as { branch: string }[],
    mergePr: [] as { branch: string }[],
    removeWorktree: [] as { force: boolean }[],
    gitAdmin: [] as string[],
  };
  let committed = true;
  let mergeError: string | null = null;
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
    async openPr(branch) {
      calls.openPr.push({ branch });
      return "https://github.com/acme/widget/pull/1";
    },
    async mergePr(branch) {
      calls.mergePr.push({ branch });
      if (mergeError !== null) throw new Error(mergeError);
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
    delete: (id) => void map.delete(id),
  };
}

function fakeMemory() {
  const journals: { path: string; markdown: string }[] = [];
  const saved: { title: string; body: string }[] = [];
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
    async writeJournal(path, markdown) {
      journals.push({ path, markdown });
    },
  };
  return { memory, journals, saved };
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
  const provider: Provider = {
    name: "fake",
    authStrategy: { kind: "api-key", isAvailable: () => true },
    async send() {
      return { content, inputTokens: 0, outputTokens: 0 };
    },
    async stream(_m, onChunk) {
      onChunk(content);
      return { content, inputTokens: 0, outputTokens: 0 };
    },
  };
  return { provider, setReply: (r: string) => void (content = r) };
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
    vcs: () => vcs.vcs,
    events: { emit: (e) => void events.push(e) },
    messages: fakeMessages(),
    conversations: fakeConversations(),
    memory: mem.memory,
    usage: usage.usage,
    notifications: notifs.store,
    ids: () => `id-${++n}`,
    clock: () => "2026-06-13T00:00:00.000Z",
  });
});

// ── projects ─────────────────────────────────────────────────────────────────

describe("projects", () => {
  it("lists projects as DTOs (no urls or on-disk paths leaked)", () => {
    expect(orch.listProjects()).toEqual([{ id: "widget", owner: "acme", name: "widget", baseBranch: "main" }]);
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
    expect(ctx).toMatch(/do NOT claim you can.?t see/i); // tells Iris she HAS this info
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
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true); // still cleaned up
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
  it("aborts + cleans up tasks left mid-flight by a crash", async () => {
    const draft = orch.createTask(PROPOSAL);
    // Simulate a hard crash: persist it executing with a worktree but no live pipeline.
    store.save({ ...store.load(draft.id)!, status: "executing", worktreePath: "/wt/zombie" });

    const cleaned = await orch.reconcile();

    expect(cleaned).toBe(1);
    expect(store.load(draft.id)!.status).toBe("aborted");
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true);
  });

  it("leaves terminal/draft tasks untouched", async () => {
    orch.createTask(PROPOSAL); // created (draft)
    const cleaned = await orch.reconcile();
    expect(cleaned).toBe(0);
  });
});
