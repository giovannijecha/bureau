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
  };
  return { store, map };
}

function fakeVcs() {
  const calls = {
    ensureClone: 0,
    syncClone: 0,
    workingDiff: 0,
    setupWorktree: [] as { branch: string; path: string }[],
    commitAll: [] as { path: string; message: string }[],
    push: [] as { path: string; branch: string }[],
    openPr: [] as { branch: string }[],
    mergePr: [] as { branch: string }[],
    removeWorktree: [] as { force: boolean }[],
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
};

let store: TaskStore;
let vcs: ReturnType<typeof fakeVcs>;
let mem: ReturnType<typeof fakeMemory>;
let usage: ReturnType<typeof fakeUsage>;
let notifs: ReturnType<typeof fakeNotifications>;
let prov: ReturnType<typeof fakeProvider>;
let captured: CapabilityInput | null;
let reviewInput: CapabilityInput | null;
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

    expect(reviewInput?.diff).toBe("DIFF-CONTENT"); // the fake vcs.workingDiff
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

// ── integrity & recovery ─────────────────────────────────────────────────────

describe("capability integrity", () => {
  it("rejects creating a task whose capability isn't registered (no silent no-op)", () => {
    expect(() =>
      orch.createTask({ title: "T", summary: "S", steps: [{ capability: "test", description: "d" }] })
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("fails LOUD (aborts, step failed, no commit) if a step's capability is unregistered at run time", async () => {
    const draft = orch.createTask(PROPOSAL); // valid edit step
    // Tamper past createTask's guard: swap to an unregistered capability in the store
    // ("test" is not registered in this harness; edit/review/document are).
    const t = store.load(draft.id)!;
    store.save({ ...t, steps: t.steps.map((s) => ({ ...s, capability: "test" as const })) });

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
