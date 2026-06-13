import { describe, it, expect, beforeEach } from "vitest";

import { canPush } from "@bureau/core";
import type { Task } from "@bureau/core";
import { CapabilityRegistry } from "@bureau/capabilities";
import type { CapabilityInput } from "@bureau/capabilities";
import type { Provider } from "@bureau/providers";
import type { WsEvent, Message, TaskProposal } from "@bureau/contracts";

import { Orchestrator, type OrchestratorConfig } from "../src/orchestrator.js";
import type { TaskStore, VcsPort } from "../src/ports.js";
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
    workingDiff: 0,
    setupWorktree: [] as { branch: string; path: string }[],
    commitAll: [] as { path: string; message: string }[],
    push: [] as { path: string; branch: string }[],
    openPr: [] as { branch: string }[],
    mergePr: [] as { branch: string }[],
    removeWorktree: [] as { force: boolean }[],
  };
  let committed = true;
  const vcs: VcsPort = {
    async ensureClone() {
      calls.ensureClone++;
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
    },
    async removeWorktree(_ref, force) {
      calls.removeWorktree.push({ force });
    },
  };
  return { vcs, calls, setCommitted: (v: boolean) => void (committed = v) };
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

const CONFIG: OrchestratorConfig = {
  repoOwner: "acme",
  repoName: "widget",
  baseBranch: "main",
  worktreesDir: "/tmp/wt",
};

let store: TaskStore;
let vcs: ReturnType<typeof fakeVcs>;
let prov: ReturnType<typeof fakeProvider>;
let captured: CapabilityInput | null;
let events: WsEvent[];
let messages: Message[];
let orch: Orchestrator;

beforeEach(() => {
  store = fakeStore().store;
  vcs = fakeVcs();
  prov = fakeProvider(JSON.stringify({ reply: "Sure!", proposal: PROPOSAL }));
  const registry = new CapabilityRegistry();
  captured = null;
  registry.register({
    kind: "edit",
    async execute(input) {
      captured = input;
      return { artifacts: [], summary: "edited" };
    },
  });
  events = [];
  messages = [];
  let n = 0;
  orch = new Orchestrator({
    store,
    capabilities: registry,
    provider: prov.provider,
    vcs: vcs.vcs,
    events: { emit: (e) => void events.push(e) },
    messages: { append: (m) => void messages.push(m), list: () => messages },
    config: CONFIG,
    ids: () => `id-${++n}`,
    clock: () => "2026-06-13T00:00:00.000Z",
  });
});

// ── chat ─────────────────────────────────────────────────────────────────────

describe("chat", () => {
  it("returns Iris's reply and a proposal, and never touches the repo", async () => {
    const res = await orch.chat("add a quick start to the readme");
    expect(res.reply.role).toBe("iris");
    expect(res.reply.content).toBe("Sure!");
    expect(res.proposal).toEqual(PROPOSAL);
    expect(vcs.calls.ensureClone).toBe(0); // chatting creates nothing
    expect(store.list()).toHaveLength(0);
  });

  it("returns just a reply when Iris is only chatting (no proposal)", async () => {
    prov.setReply(JSON.stringify({ reply: "Tell me more." }));
    const res = await orch.chat("hi");
    expect(res.reply.content).toBe("Tell me more.");
    expect(res.proposal).toBeUndefined();
  });
});

// ── createTask ─────────────────────────────────────────────────────────────

describe("createTask", () => {
  it("materializes a DRAFT task (created, not started) with a pr_approval gate", () => {
    const task = orch.createTask(PROPOSAL);
    expect(task.status).toBe("created");
    expect(task.goal).toBe(PROPOSAL.title);
    expect(task.steps).toHaveLength(1);
    expect(task.steps[0]!.gateAfter).toBe(task.gates[0]!.id);
    expect(task.gates[0]!.kind).toBe("pr_approval");
    expect(vcs.calls.ensureClone).toBe(0); // not started
    expect(toTaskDetail(task).steps[0]!.assignee).toBe("Editor");
  });
});

// ── startTask ──────────────────────────────────────────────────────────────

describe("startTask", () => {
  it("runs the pipeline and commits LOCALLY without pushing", async () => {
    const draft = orch.createTask(PROPOSAL);
    const task = await orch.startTask(draft.id);

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

  it("rejects starting a task that isn't a draft", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);
    await expect(orch.startTask(draft.id)).rejects.toMatchObject({ status: 409 });
  });
});

// ── confirmMerge — the security wall ─────────────────────────────────────────

describe("confirmMerge", () => {
  it("pushes, opens the PR, and squash-merges exactly once — only after canPush", async () => {
    const draft = orch.createTask(PROPOSAL);
    const started = await orch.startTask(draft.id);
    expect(canPush(started)).toBe(false);

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

// ── stopTask ─────────────────────────────────────────────────────────────────

describe("stopTask", () => {
  it("aborts the task and force-removes its worktree, never pushing", async () => {
    const draft = orch.createTask(PROPOSAL);
    await orch.startTask(draft.id);

    const stopped = await orch.stopTask(draft.id);

    expect(stopped.status).toBe("aborted");
    expect(vcs.calls.removeWorktree.some((c) => c.force)).toBe(true);
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.mergePr).toHaveLength(0);
  });

  it("throws 404 for an unknown task", async () => {
    await expect(orch.stopTask("nope")).rejects.toMatchObject({ status: 404 });
  });
});
