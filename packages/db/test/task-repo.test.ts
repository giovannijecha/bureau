import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { createDb, runMigrations, type BureauDb } from "../src/client.js";
import { TaskRepo } from "../src/repo.js";
import {
  tasks as tasksTable,
  steps as stepsTable,
  gates as gatesTable,
  artifacts as artifactsTable,
  decisionLog as decisionLogTable,
} from "../src/schema.js";
import { transition, type TransitionEvent } from "@bureau/core";
import type {
  Task,
  TaskId,
  Step,
  StepId,
  Gate,
  GateId,
  Artifact,
  ArtifactId,
  AcceptanceCriterion,
  DecisionEntry,
} from "@bureau/core";

// ---------------------------------------------------------------------------
// Brand helpers + fixtures
// ---------------------------------------------------------------------------

const tid = (s: string) => s as unknown as TaskId;
const sid = (s: string) => s as unknown as StepId;
const gid = (s: string) => s as unknown as GateId;
const aid = (s: string) => s as unknown as ArtifactId;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: tid("task-1"),
    goal: "ship the widget",
    repoOwner: "acme",
    repoName: "widget",
    status: "created",
    steps: [],
    gates: [],
    artifacts: [],
    decisionLog: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const criterion = (id: string, verified: boolean): AcceptanceCriterion => ({
  id,
  description: `criterion ${id}`,
  verified,
});

// A maximally-populated aggregate: every optional set on one step, none on
// another; gates covering decided+notes and undecided; artifacts; and a
// decision log containing ALL eight entry variants (a shape the DB must persist
// faithfully even though no single lifecycle produces both completed+aborted).
function richTask(): Task {
  const steps: Step[] = [
    {
      id: sid("s1"),
      capability: "edit",
      description: "edit the files",
      acceptanceCriteria: [criterion("c1", true), criterion("c2", false)],
      status: "completed",
      artifactIds: [aid("a1"), aid("a2")],
      gateAfter: gid("g1"),
      startedAt: "2026-01-01T01:00:00.000Z",
      completedAt: "2026-01-01T02:00:00.000Z",
      failureReason: "n/a but persisted",
      summary: "edited the files and reported it",
    },
    {
      id: sid("s2"),
      capability: "test",
      description: "run the tests",
      acceptanceCriteria: [],
      status: "pending",
      artifactIds: [],
    },
  ];

  const gates: Gate[] = [
    {
      id: gid("g1"),
      kind: "diff_review",
      status: "approved",
      decidedAt: "2026-01-01T03:00:00.000Z",
      decision: "approved",
      notes: "looks good",
    },
    { id: gid("g2"), kind: "pr_approval", status: "pending" },
  ];

  const artifacts: Artifact[] = [
    { id: aid("a1"), kind: "diff", ref: "change.diff", producedByStep: sid("s1"), createdAt: "2026-01-01T01:30:00.000Z" },
    { id: aid("a2"), kind: "pr_url", ref: "https://example.test/pr/1", producedByStep: sid("s1"), createdAt: "2026-01-01T04:00:00.000Z" },
  ];

  const decisionLog: DecisionEntry[] = [
    { type: "task_created", at: "2026-01-01T00:00:00.000Z", goal: "ship the widget" },
    { type: "step_started", at: "2026-01-01T01:00:00.000Z", stepId: sid("s1") },
    { type: "step_completed", at: "2026-01-01T02:00:00.000Z", stepId: sid("s1") },
    { type: "step_failed", at: "2026-01-01T02:05:00.000Z", stepId: sid("s2"), reason: "flaky" },
    { type: "gate_opened", at: "2026-01-01T02:30:00.000Z", gateId: gid("g1") },
    { type: "gate_reopened", at: "2026-01-01T02:45:00.000Z", gateId: gid("g1") },
    { type: "gate_decided", at: "2026-01-01T03:00:00.000Z", gateId: gid("g1"), decision: "approved", notes: "looks good" },
    { type: "gate_decided", at: "2026-01-01T03:10:00.000Z", gateId: gid("g2"), decision: "rejected" }, // no notes
    { type: "task_completed", at: "2026-01-01T05:00:00.000Z" },
    { type: "task_aborted", at: "2026-01-01T06:00:00.000Z", reason: "changed my mind" },
  ];

  return makeTask({
    id: tid("task-rich"),
    worktreePath: "/tmp/wt/task-rich",
    status: "awaiting_human",
    steps,
    gates,
    artifacts,
    decisionLog,
  });
}

// ---------------------------------------------------------------------------

let db: BureauDb;
let repo: TaskRepo;

beforeEach(() => {
  db = createDb(":memory:");
  runMigrations(db);
  repo = new TaskRepo(db);
});

describe("TaskRepo — round-trip fidelity", () => {
  it("round-trips a minimal task with no children", () => {
    const task = makeTask();
    repo.save(task);
    expect(repo.load(task.id)).toEqual(task);
  });

  it("round-trips a fully-populated aggregate deep-equal", () => {
    const task = richTask();
    repo.save(task);
    expect(repo.load(task.id)).toEqual(task);
  });

  it("round-trips every decision-log entry variant exactly", () => {
    const task = richTask();
    repo.save(task);
    const loaded = repo.load(task.id)!;
    expect(loaded.decisionLog).toEqual(task.decisionLog);
  });

  it("preserves step / gate / artifact ordering", () => {
    const task = makeTask({
      steps: [
        { id: sid("s3"), capability: "edit", description: "third", acceptanceCriteria: [], status: "pending", artifactIds: [] },
        { id: sid("s1"), capability: "edit", description: "first", acceptanceCriteria: [], status: "pending", artifactIds: [] },
        { id: sid("s2"), capability: "edit", description: "second", acceptanceCriteria: [], status: "pending", artifactIds: [] },
      ],
    });
    repo.save(task);
    const loaded = repo.load(task.id)!;
    expect(loaded.steps.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
  });
});

describe("TaskRepo — optional-field absence is preserved", () => {
  it("omits worktreePath / step+gate optionals that were never set", () => {
    const task = makeTask({
      steps: [{ id: sid("s1"), capability: "edit", description: "x", acceptanceCriteria: [], status: "pending", artifactIds: [] }],
      gates: [{ id: gid("g1"), kind: "pr_approval", status: "pending" }],
    });
    repo.save(task);
    const loaded = repo.load(task.id)!;

    expect("worktreePath" in loaded).toBe(false);
    expect("gateAfter" in loaded.steps[0]!).toBe(false);
    expect("startedAt" in loaded.steps[0]!).toBe(false);
    expect("completedAt" in loaded.steps[0]!).toBe(false);
    expect("failureReason" in loaded.steps[0]!).toBe(false);
    expect("summary" in loaded.steps[0]!).toBe(false);
    expect("decidedAt" in loaded.gates[0]!).toBe(false);
    expect("decision" in loaded.gates[0]!).toBe(false);
    expect("notes" in loaded.gates[0]!).toBe(false);
  });

  it("omits notes on a gate_decided entry that had none", () => {
    const task = makeTask({
      decisionLog: [{ type: "gate_decided", at: "2026-01-01T03:10:00.000Z", gateId: gid("g2"), decision: "rejected" }],
    });
    repo.save(task);
    const loaded = repo.load(task.id)!;
    expect("notes" in loaded.decisionLog[0]!).toBe(false);
  });
});

describe("TaskRepo — load / list / delete", () => {
  it("returns null for a missing task", () => {
    expect(repo.load(tid("nope"))).toBeNull();
  });

  it("lists all tasks oldest-first by createdAt", () => {
    repo.save(makeTask({ id: tid("b"), createdAt: "2026-02-01T00:00:00.000Z" }));
    repo.save(makeTask({ id: tid("a"), createdAt: "2026-01-01T00:00:00.000Z" }));
    repo.save(makeTask({ id: tid("c"), createdAt: "2026-03-01T00:00:00.000Z" }));
    expect(repo.list().map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("delete removes the task and cascades all children", () => {
    const task = richTask();
    repo.save(task);
    repo.delete(task.id);

    expect(repo.load(task.id)).toBeNull();
    // No orphaned child rows remain.
    expect(db.select().from(stepsTable).where(eq(stepsTable.taskId, task.id)).all()).toHaveLength(0);
    expect(db.select().from(gatesTable).where(eq(gatesTable.taskId, task.id)).all()).toHaveLength(0);
    expect(db.select().from(artifactsTable).where(eq(artifactsTable.taskId, task.id)).all()).toHaveLength(0);
    expect(db.select().from(decisionLogTable).where(eq(decisionLogTable.taskId, task.id)).all()).toHaveLength(0);
  });
});

describe("TaskRepo — save is an idempotent full replace (upsert)", () => {
  it("re-saving the same task does not duplicate child rows", () => {
    const task = richTask();
    repo.save(task);
    repo.save(task);
    repo.save(task);

    expect(db.select().from(stepsTable).where(eq(stepsTable.taskId, task.id)).all()).toHaveLength(2);
    expect(db.select().from(decisionLogTable).where(eq(decisionLogTable.taskId, task.id)).all()).toHaveLength(10);
    expect(repo.load(task.id)).toEqual(task);
  });

  it("updates scalar fields and drops children that were removed", () => {
    const task = richTask();
    repo.save(task);

    const slimmed: Task = makeTask({
      id: task.id,
      worktreePath: "/tmp/wt/task-rich",
      status: "completed",
      steps: [task.steps[0]!], // dropped s2
      gates: [], // dropped both gates
      artifacts: [],
      decisionLog: task.decisionLog,
    });
    repo.save(slimmed);

    const loaded = repo.load(task.id)!;
    expect(loaded.status).toBe("completed");
    expect(loaded.steps.map((s) => s.id)).toEqual(["s1"]);
    expect(loaded.gates).toHaveLength(0);
    expect(loaded).toEqual(slimmed);
  });
});

describe("TaskRepo — child ids are scoped to their task", () => {
  const withChildren = (taskId: string): Task =>
    makeTask({
      id: tid(taskId),
      steps: [{ id: sid("s1"), capability: "edit", description: "x", acceptanceCriteria: [], status: "pending", artifactIds: [] }],
      gates: [{ id: gid("g1"), kind: "pr_approval", status: "pending" }],
      artifacts: [{ id: aid("a1"), kind: "diff", ref: "d", producedByStep: sid("s1"), createdAt: "2026-01-01T00:00:00.000Z" }],
    });

  it("lets two different tasks reuse the same step/gate/artifact ids", () => {
    repo.save(withChildren("task-a"));
    repo.save(withChildren("task-b")); // would throw UNIQUE on global child PKs

    expect(repo.load(tid("task-a"))!.steps[0]!.id).toBe("s1");
    expect(repo.load(tid("task-b"))!.gates[0]!.id).toBe("g1");
    expect(repo.load(tid("task-b"))!.artifacts[0]!.id).toBe("a1");
  });
});

describe("TaskRepo — list() ordering is deterministic", () => {
  it("breaks equal-createdAt ties by id ascending", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    repo.save(makeTask({ id: tid("zzz"), createdAt: ts }));
    repo.save(makeTask({ id: tid("aaa"), createdAt: ts }));
    repo.save(makeTask({ id: tid("mmm"), createdAt: ts }));
    expect(repo.list().map((t) => t.id)).toEqual(["aaa", "mmm", "zzz"]);
  });
});

describe("TaskRepo — corrupt decision_log fails loud", () => {
  it("load() throws when a known-type entry is missing its required column", () => {
    repo.save(makeTask({ id: tid("corrupt") }));
    // Hand-insert a malformed step_failed row (reason NULL) the writer never produces.
    db.insert(decisionLogTable)
      .values({ taskId: tid("corrupt"), orderIdx: 0, type: "step_failed", at: "2026-01-01T00:00:00.000Z", stepId: "s1", reason: null })
      .run();

    expect(() => repo.load(tid("corrupt"))).toThrow(/Corrupt decision_log/);
  });
});

describe("TaskRepo — persists a state-machine-driven lifecycle", () => {
  it("drives a real transition sequence, saves the result, and loads it back deep-equal", () => {
    let task = makeTask({
      id: tid("task-live"),
      status: "created",
      steps: [{ id: sid("s1"), capability: "edit", description: "edit", acceptanceCriteria: [], status: "pending", artifactIds: [], gateAfter: gid("g1") }],
      gates: [{ id: gid("g1"), kind: "pr_approval", status: "pending" }],
    });

    const drive: TransitionEvent[] = [
      { type: "START_PLANNING" },
      { type: "PLANNING_DONE" },
      { type: "START_STEP", stepId: sid("s1") },
      { type: "COMPLETE_STEP", stepId: sid("s1") },
      { type: "OPEN_GATE", gateId: gid("g1") },
      { type: "DECIDE_GATE", gateId: gid("g1"), decision: "approved", notes: "ship it" },
      { type: "COMPLETE_TASK" },
    ];
    for (const event of drive) task = transition(task, event);

    repo.save(task);
    expect(repo.load(task.id)).toEqual(task);
    expect(repo.load(task.id)!.decisionLog.map((e) => e.type)).toEqual([
      "task_created",
      "step_started",
      "step_completed",
      "gate_opened",
      "gate_decided",
      "task_completed",
    ]);
  });
});
