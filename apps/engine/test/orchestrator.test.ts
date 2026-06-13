import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";

import { canPush } from "@bureau/core";
import type { Task } from "@bureau/core";
import { CapabilityRegistry } from "@bureau/capabilities";
import type { CapabilityInput } from "@bureau/capabilities";
import type { WsEvent, Message } from "@bureau/contracts";

import { Orchestrator, type OrchestratorConfig } from "../src/orchestrator.js";
import type { TaskStore, VcsPort } from "../src/ports.js";
import { latestDiff, prUrl, toTaskSummary } from "../src/summary.js";

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
    openPr: [] as { branch: string; title: string; body: string }[],
  };
  let committed = true;
  let openPrFails = false;
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
    async openPr(branch, title, body) {
      calls.openPr.push({ branch, title, body });
      if (openPrFails) throw new Error("gh: PR creation failed");
      return "https://github.com/acme/widget/pull/1";
    },
    async removeWorktree() {},
  };
  return {
    vcs,
    calls,
    setCommitted: (v: boolean) => void (committed = v),
    setOpenPrFails: (v: boolean) => void (openPrFails = v),
  };
}

const CONFIG: OrchestratorConfig = {
  repoOwner: "acme",
  repoName: "widget",
  baseBranch: "main",
  worktreesDir: "/tmp/wt",
};

let store: TaskStore;
let vcs: ReturnType<typeof fakeVcs>;
let registry: CapabilityRegistry;
let captured: CapabilityInput | null;
let events: WsEvent[];
let messages: Message[];
let orch: Orchestrator;

beforeEach(() => {
  const s = fakeStore();
  store = s.store;
  vcs = fakeVcs();
  registry = new CapabilityRegistry();
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
    vcs: vcs.vcs,
    events: { emit: (e) => void events.push(e) },
    messages: { append: (m) => void messages.push(m), list: () => messages },
    config: CONFIG,
    ids: () => `id-${++n}`,
    clock: () => "2026-06-13T00:00:00.000Z",
  });
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("handleMessage", () => {
  it("drives a task to awaiting_human with a diff, WITHOUT pushing", async () => {
    const { task } = await orch.handleMessage("add a hello module");

    expect(task.status).toBe("awaiting_human");
    expect(task.gates[0]!.kind).toBe("pr_approval");
    expect(task.gates[0]!.status).toBe("open");
    expect(latestDiff(task)).toBe("DIFF-CONTENT");

    // The wall is closed: nothing pushed, canPush false.
    expect(canPush(task)).toBe(false);
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.openPr).toHaveLength(0);

    // Worktree was set up on the task's branch.
    expect(vcs.calls.ensureClone).toBe(1);
    expect(vcs.calls.setupWorktree[0]!.branch).toBe(`bureau/task-${task.id}`);
    expect(task.worktreePath).toBe(join("/tmp/wt", task.id));
  });

  it("runs the edit capability with the running step, worktree, and goal as context", async () => {
    await orch.handleMessage("the goal text");
    expect(captured).not.toBeNull();
    expect(captured!.step.capability).toBe("edit");
    expect(captured!.step.status).toBe("running");
    expect(captured!.worktreePath).toBe(join("/tmp/wt", store.list()[0]!.id));
    expect(captured!.context).toBe("the goal text");
  });

  it("emits the lifecycle events the panel listens for", async () => {
    await orch.handleMessage("x");
    const types = events.map((e) => e.type);
    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
    expect(types).toContain("gate_opened");
    expect(types).toContain("task_updated");
    expect(types).toContain("iris_message");
  });
});

describe("decideGate — the security wall", () => {
  it("approval completes the task and opens a PR exactly once", async () => {
    const { task } = await orch.handleMessage("add feature");
    const gateId = task.gates[0]!.id;

    const after = await orch.decideGate(gateId, "approved");

    expect(after.status).toBe("completed");
    expect(canPush(after)).toBe(true);
    expect(vcs.calls.commitAll).toHaveLength(1);
    expect(vcs.calls.push).toHaveLength(1);
    expect(vcs.calls.openPr).toHaveLength(1);
    expect(vcs.calls.push[0]!.branch).toBe(`bureau/task-${after.id}`);
    expect(prUrl(after)).toBe("https://github.com/acme/widget/pull/1");
  });

  it("rejection never pushes and leaves canPush false", async () => {
    const { task } = await orch.handleMessage("add feature");

    const after = await orch.decideGate(task.gates[0]!.id, "rejected");

    expect(after.status).toBe("awaiting_human");
    expect(after.gates[0]!.status).toBe("rejected");
    expect(canPush(after)).toBe(false);
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.openPr).toHaveLength(0);
  });

  it("request_changes never pushes", async () => {
    const { task } = await orch.handleMessage("add feature");
    const after = await orch.decideGate(task.gates[0]!.id, "request_changes");
    expect(after.gates[0]!.status).toBe("rejected");
    expect(vcs.calls.push).toHaveLength(0);
    expect(vcs.calls.openPr).toHaveLength(0);
  });

  it("a no-op edit (nothing to commit) completes but does not push", async () => {
    vcs.setCommitted(false);
    const { task } = await orch.handleMessage("noop change");

    const after = await orch.decideGate(task.gates[0]!.id, "approved");

    expect(after.status).toBe("completed");
    expect(vcs.calls.commitAll).toHaveLength(1);
    expect(vcs.calls.push).toHaveLength(0); // nothing committed → nothing pushed
    expect(vcs.calls.openPr).toHaveLength(0);
  });

  it("throws for an unknown gate id", async () => {
    await expect(orch.decideGate("does-not-exist", "approved")).rejects.toThrow(/No task found/);
  });
});

describe("decideGate — partial-failure recovery", () => {
  it("an openPr failure after a successful push leaves the task recoverable, without throwing", async () => {
    vcs.setOpenPrFails(true);
    const { task } = await orch.handleMessage("add feature");

    const after = await orch.decideGate(task.gates[0]!.id, "approved");

    expect(after.status).toBe("completed");
    expect(vcs.calls.push).toHaveLength(1); // branch pushed
    expect(vcs.calls.openPr).toHaveLength(1); // PR attempted
    expect(prUrl(after)).toBeNull(); // but no PR recorded
    expect(messages.some((m) => m.role === "iris" && /retry/i.test(m.content))).toBe(true);

    // Retry succeeds → PR opened, no double-push-then-throw.
    vcs.setOpenPrFails(false);
    const recovered = await orch.retryPr(after.id);
    expect(prUrl(recovered)).toBe("https://github.com/acme/widget/pull/1");
    expect(vcs.calls.openPr).toHaveLength(2);
  });

  it("retryPr is a no-op once the PR already exists", async () => {
    const { task } = await orch.handleMessage("add feature");
    const done = await orch.decideGate(task.gates[0]!.id, "approved");
    const opens = vcs.calls.openPr.length;

    const again = await orch.retryPr(done.id);
    expect(prUrl(again)).toBe(prUrl(done));
    expect(vcs.calls.openPr).toHaveLength(opens); // not opened a second time
  });
});

describe("decideGate — conflicts", () => {
  it("re-deciding an already-approved gate is a 409 and never double-pushes", async () => {
    const { task } = await orch.handleMessage("add feature");
    const gateId = task.gates[0]!.id;
    await orch.decideGate(gateId, "approved");
    const pushes = vcs.calls.push.length;

    await expect(orch.decideGate(gateId, "approved")).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.push).toHaveLength(pushes);
  });

  it("approving a gate that was already rejected is a 409 conflict", async () => {
    const { task } = await orch.handleMessage("add feature");
    const gateId = task.gates[0]!.id;
    await orch.decideGate(gateId, "rejected");

    await expect(orch.decideGate(gateId, "approved")).rejects.toMatchObject({ status: 409 });
    expect(vcs.calls.push).toHaveLength(0);
  });
});

describe("toTaskSummary", () => {
  it("summarizes counts for the panel", async () => {
    const { task } = await orch.handleMessage("x");
    const summary = toTaskSummary(task);
    expect(summary.status).toBe("awaiting_human");
    expect(summary.stepCount).toBe(1);
    expect(summary.pendingGates).toBe(1); // the open gate
    expect(summary.repoOwner).toBe("acme");
  });
});
