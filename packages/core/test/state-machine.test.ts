import { describe, it, expect } from "vitest";

import {
  transition,
  canPush,
  TransitionError,
  type TransitionEvent,
} from "../src/state-machine.js";
import type {
  Task,
  TaskId,
  TaskStatus,
  Step,
  StepId,
  StepStatus,
  Gate,
  GateId,
  GateKind,
  GateStatus,
  HumanDecision,
  Artifact,
  ArtifactId,
  DecisionEntry,
} from "../src/task.js";

// ---------------------------------------------------------------------------
// Brand helpers + fixture factories
// ---------------------------------------------------------------------------

const tid = (s: string) => s as unknown as TaskId;
const sid = (s: string) => s as unknown as StepId;
const gid = (s: string) => s as unknown as GateId;
const aid = (s: string) => s as unknown as ArtifactId;

/** A deliberately stale timestamp so we can prove `updatedAt` is rewritten. */
const STALE = "2020-01-01T00:00:00.000Z";

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
    createdAt: STALE,
    updatedAt: STALE,
    ...overrides,
  };
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: sid("step-1"),
    capability: "edit",
    description: "edit the files",
    acceptanceCriteria: [],
    status: "pending",
    artifactIds: [],
    ...overrides,
  };
}

function makeGate(overrides: Partial<Gate> = {}): Gate {
  return {
    id: gid("gate-1"),
    kind: "pr_approval",
    status: "pending",
    ...overrides,
  };
}

const ALL_STATUSES: readonly TaskStatus[] = [
  "created",
  "planning",
  "executing",
  "awaiting_human",
  "completed",
  "aborted",
];

const NON_RUNNING_STEP_STATUSES: readonly StepStatus[] = [
  "pending",
  "completed",
  "failed",
  "blocked_on_gate",
];

const NON_PENDING_GATE_STATUSES: readonly GateStatus[] = ["open", "approved", "rejected"];

/** Assert a transition is rejected as illegal (and never mutates anything). */
function expectIllegal(task: Task, event: TransitionEvent): void {
  expect(() => transition(task, event)).toThrow(TransitionError);
}

// ===========================================================================
// transition() — legal transitions
// ===========================================================================

describe("transition() — START_PLANNING", () => {
  it("moves created → planning and logs task_created with the goal", () => {
    const task = makeTask({ status: "created", goal: "do X" });
    const next = transition(task, { type: "START_PLANNING" });

    expect(next.status).toBe("planning");
    expect(next.decisionLog).toHaveLength(1);
    expect(next.decisionLog[0]).toMatchObject({ type: "task_created", goal: "do X" });
    expect(next.updatedAt).not.toBe(STALE);
  });

  it.each(ALL_STATUSES.filter((s) => s !== "created"))(
    "is illegal from status %s",
    (status) => {
      expectIllegal(makeTask({ status }), { type: "START_PLANNING" });
    }
  );
});

describe("transition() — PLANNING_DONE", () => {
  it("moves planning → executing without writing a log entry", () => {
    const task = makeTask({ status: "planning" });
    const next = transition(task, { type: "PLANNING_DONE" });

    expect(next.status).toBe("executing");
    expect(next.decisionLog).toHaveLength(0);
    expect(next.updatedAt).not.toBe(STALE);
  });

  it.each(ALL_STATUSES.filter((s) => s !== "planning"))(
    "is illegal from status %s",
    (status) => {
      expectIllegal(makeTask({ status }), { type: "PLANNING_DONE" });
    }
  );
});

describe("transition() — START_STEP", () => {
  it("moves a pending step → running, sets startedAt, logs step_started", () => {
    const step = makeStep({ id: sid("s1"), status: "pending" });
    const task = makeTask({ status: "executing", steps: [step] });

    const next = transition(task, { type: "START_STEP", stepId: sid("s1") });

    expect(next.steps[0]!.status).toBe("running");
    expect(next.steps[0]!.startedAt).not.toBeUndefined();
    expect(next.decisionLog.at(-1)).toMatchObject({ type: "step_started", stepId: "s1" });
  });

  it("starts only the targeted step and leaves sibling steps untouched", () => {
    const task = makeTask({
      status: "executing",
      steps: [
        makeStep({ id: sid("s1"), status: "pending" }),
        makeStep({ id: sid("s2"), status: "pending" }),
      ],
    });

    const next = transition(task, { type: "START_STEP", stepId: sid("s2") });

    expect(next.steps[0]!.status).toBe("pending"); // sibling unchanged
    expect(next.steps[1]!.status).toBe("running"); // target started
    expect(next.steps[0]).toBe(task.steps[0]); // identity preserved for untouched step
  });

  it.each(ALL_STATUSES.filter((s) => s !== "executing"))(
    "is illegal when task status is %s (status wall)",
    (status) => {
      const task = makeTask({ status, steps: [makeStep({ id: sid("s1") })] });
      expectIllegal(task, { type: "START_STEP", stepId: sid("s1") });
    }
  );

  it("is illegal when the step does not exist", () => {
    const task = makeTask({ status: "executing", steps: [makeStep({ id: sid("s1") })] });
    expectIllegal(task, { type: "START_STEP", stepId: sid("ghost") });
  });

  it.each(["running", "completed", "failed", "blocked_on_gate"] as StepStatus[])(
    "is illegal when the step is already %s",
    (stepStatus) => {
      const task = makeTask({
        status: "executing",
        steps: [makeStep({ id: sid("s1"), status: stepStatus })],
      });
      expectIllegal(task, { type: "START_STEP", stepId: sid("s1") });
    }
  );
});

describe("transition() — COMPLETE_STEP", () => {
  it("completes a running step with no gate → completed + completedAt", () => {
    const step = makeStep({ id: sid("s1"), status: "running" });
    const task = makeTask({ status: "executing", steps: [step] });

    const next = transition(task, { type: "COMPLETE_STEP", stepId: sid("s1") });

    expect(next.steps[0]!.status).toBe("completed");
    expect(next.steps[0]!.completedAt).not.toBeUndefined();
    expect(next.decisionLog.at(-1)).toMatchObject({ type: "step_completed", stepId: "s1" });
  });

  it("completes a running step that has a gateAfter → blocked_on_gate", () => {
    const step = makeStep({ id: sid("s1"), status: "running", gateAfter: gid("g1") });
    const task = makeTask({ status: "executing", steps: [step] });

    const next = transition(task, { type: "COMPLETE_STEP", stepId: sid("s1") });

    expect(next.steps[0]!.status).toBe("blocked_on_gate");
    expect(next.steps[0]!.completedAt).not.toBeUndefined();
  });

  it.each(ALL_STATUSES.filter((s) => s !== "executing"))(
    "is illegal when task status is %s",
    (status) => {
      const task = makeTask({
        status,
        steps: [makeStep({ id: sid("s1"), status: "running" })],
      });
      expectIllegal(task, { type: "COMPLETE_STEP", stepId: sid("s1") });
    }
  );

  it("is illegal when the step does not exist", () => {
    const task = makeTask({ status: "executing", steps: [makeStep({ id: sid("s1") })] });
    expectIllegal(task, { type: "COMPLETE_STEP", stepId: sid("ghost") });
  });

  it.each(NON_RUNNING_STEP_STATUSES)(
    "is illegal when the step is %s (not running)",
    (stepStatus) => {
      const task = makeTask({
        status: "executing",
        steps: [makeStep({ id: sid("s1"), status: stepStatus })],
      });
      expectIllegal(task, { type: "COMPLETE_STEP", stepId: sid("s1") });
    }
  );
});

describe("transition() — FAIL_STEP", () => {
  it("fails a running step → failed + reason + completedAt, logs step_failed", () => {
    const step = makeStep({ id: sid("s1"), status: "running" });
    const task = makeTask({ status: "executing", steps: [step] });

    const next = transition(task, {
      type: "FAIL_STEP",
      stepId: sid("s1"),
      reason: "compiler exploded",
    });

    expect(next.steps[0]!.status).toBe("failed");
    expect(next.steps[0]!.failureReason).toBe("compiler exploded");
    expect(next.steps[0]!.completedAt).not.toBeUndefined();
    expect(next.decisionLog.at(-1)).toMatchObject({
      type: "step_failed",
      stepId: "s1",
      reason: "compiler exploded",
    });
  });

  it("does NOT assert task status — a running step can fail while awaiting_human", () => {
    const step = makeStep({ id: sid("s1"), status: "running" });
    const task = makeTask({ status: "awaiting_human", steps: [step] });

    const next = transition(task, { type: "FAIL_STEP", stepId: sid("s1"), reason: "boom" });

    expect(next.steps[0]!.status).toBe("failed");
    // Task status is left untouched by FAIL_STEP.
    expect(next.status).toBe("awaiting_human");
  });

  it("is illegal when the step does not exist", () => {
    const task = makeTask({ status: "executing", steps: [makeStep({ id: sid("s1") })] });
    expectIllegal(task, { type: "FAIL_STEP", stepId: sid("ghost"), reason: "x" });
  });

  it.each(NON_RUNNING_STEP_STATUSES)(
    "is illegal when the step is %s (not running)",
    (stepStatus) => {
      const task = makeTask({
        status: "executing",
        steps: [makeStep({ id: sid("s1"), status: stepStatus })],
      });
      expectIllegal(task, { type: "FAIL_STEP", stepId: sid("s1"), reason: "x" });
    }
  );
});

describe("transition() — OPEN_GATE", () => {
  it("opens a pending gate → open and parks the task at awaiting_human", () => {
    const gate = makeGate({ id: gid("g1"), status: "pending" });
    const task = makeTask({ status: "executing", gates: [gate] });

    const next = transition(task, { type: "OPEN_GATE", gateId: gid("g1") });

    expect(next.gates[0]!.status).toBe("open");
    expect(next.status).toBe("awaiting_human");
    expect(next.decisionLog.at(-1)).toMatchObject({ type: "gate_opened", gateId: "g1" });
  });

  it("is illegal when the gate does not exist", () => {
    const task = makeTask({ status: "executing", gates: [makeGate({ id: gid("g1") })] });
    expectIllegal(task, { type: "OPEN_GATE", gateId: gid("ghost") });
  });

  it.each(NON_PENDING_GATE_STATUSES)(
    "is illegal when the gate is already %s (not pending)",
    (gateStatus) => {
      const task = makeTask({
        status: "executing",
        gates: [makeGate({ id: gid("g1"), status: gateStatus })],
      });
      expectIllegal(task, { type: "OPEN_GATE", gateId: gid("g1") });
    }
  );
});

describe("transition() — DECIDE_GATE", () => {
  function awaitingTaskWith(gates: Gate[]): Task {
    return makeTask({ status: "awaiting_human", gates });
  }

  it("approves the only open gate → gate approved and task resumes executing", () => {
    const task = awaitingTaskWith([makeGate({ id: gid("g1"), status: "open" })]);

    const next = transition(task, {
      type: "DECIDE_GATE",
      gateId: gid("g1"),
      decision: "approved",
    });

    expect(next.gates[0]!.status).toBe("approved");
    expect(next.gates[0]!.decision).toBe("approved");
    expect(next.gates[0]!.decidedAt).not.toBeUndefined();
    expect(next.status).toBe("executing");
    expect(next.decisionLog.at(-1)).toMatchObject({
      type: "gate_decided",
      gateId: "g1",
      decision: "approved",
    });
  });

  it("stores notes when provided", () => {
    const task = awaitingTaskWith([makeGate({ id: gid("g1"), status: "open" })]);
    const next = transition(task, {
      type: "DECIDE_GATE",
      gateId: gid("g1"),
      decision: "approved",
      notes: "looks good",
    });

    expect(next.gates[0]!.notes).toBe("looks good");
    expect(next.decisionLog.at(-1)).toMatchObject({ notes: "looks good" });
  });

  it("omits notes entirely when not provided", () => {
    const task = awaitingTaskWith([makeGate({ id: gid("g1"), status: "open" })]);
    const next = transition(task, {
      type: "DECIDE_GATE",
      gateId: gid("g1"),
      decision: "approved",
    });

    expect(next.gates[0]!.notes).toBeUndefined();
    expect(next.decisionLog.at(-1)).not.toHaveProperty("notes");
  });

  it("approving one gate while another is still pending keeps the task awaiting_human", () => {
    const task = awaitingTaskWith([
      makeGate({ id: gid("g1"), status: "open" }),
      makeGate({ id: gid("g2"), kind: "diff_review", status: "pending" }),
    ]);

    const next = transition(task, {
      type: "DECIDE_GATE",
      gateId: gid("g1"),
      decision: "approved",
    });

    expect(next.gates[0]!.status).toBe("approved");
    expect(next.status).toBe("awaiting_human");
    // The untouched sibling gate keeps its reference identity and prior fields.
    expect(next.gates[1]).toBe(task.gates[1]);
    expect(next.gates[1]!.status).toBe("pending");
    expect(next.gates[1]!.decision).toBeUndefined();
  });

  it("rejecting a gate sets status=rejected, keeps decision=rejected, stays awaiting_human", () => {
    const task = awaitingTaskWith([makeGate({ id: gid("g1"), status: "open" })]);

    const next = transition(task, {
      type: "DECIDE_GATE",
      gateId: gid("g1"),
      decision: "rejected",
    });

    expect(next.gates[0]!.status).toBe("rejected");
    expect(next.gates[0]!.decision).toBe("rejected");
    expect(next.gates[0]!.decidedAt).not.toBeUndefined(); // stamped on every decision, not just approvals
    expect(next.status).toBe("awaiting_human");
  });

  it("request_changes maps gate status→rejected but records decision=request_changes", () => {
    const task = awaitingTaskWith([makeGate({ id: gid("g1"), status: "open" })]);

    const next = transition(task, {
      type: "DECIDE_GATE",
      gateId: gid("g1"),
      decision: "request_changes",
    });

    expect(next.gates[0]!.status).toBe("rejected");
    expect(next.gates[0]!.decision).toBe("request_changes");
    expect(next.gates[0]!.decidedAt).not.toBeUndefined();
    expect(next.status).toBe("awaiting_human");
  });

  it("approving the last OPEN gate resumes executing even if a rejected gate lingers — but canPush stays false", () => {
    const task = awaitingTaskWith([
      makeGate({ id: gid("g1"), kind: "diff_review", status: "rejected", decision: "rejected" }),
      makeGate({ id: gid("g2"), kind: "pr_approval", status: "open" }),
    ]);

    const next = transition(task, {
      type: "DECIDE_GATE",
      gateId: gid("g2"),
      decision: "approved",
    });

    // No open/pending gates remain → state machine moves on.
    expect(next.status).toBe("executing");
    // …yet the security wall still refuses: a rejected gate is unresolved.
    expect(canPush(next)).toBe(false);
  });

  it("is illegal when the gate does not exist", () => {
    const task = awaitingTaskWith([makeGate({ id: gid("g1"), status: "open" })]);
    expectIllegal(task, { type: "DECIDE_GATE", gateId: gid("ghost"), decision: "approved" });
  });

  it.each(["pending", "approved", "rejected"] as GateStatus[])(
    "is illegal when the gate is %s (not open)",
    (gateStatus) => {
      const task = awaitingTaskWith([makeGate({ id: gid("g1"), status: gateStatus })]);
      expectIllegal(task, { type: "DECIDE_GATE", gateId: gid("g1"), decision: "approved" });
    }
  );
});

describe("transition() — COMPLETE_TASK", () => {
  it("moves executing → completed and logs task_completed", () => {
    const task = makeTask({ status: "executing" });
    const next = transition(task, { type: "COMPLETE_TASK" });

    expect(next.status).toBe("completed");
    expect(next.decisionLog.at(-1)).toMatchObject({ type: "task_completed" });
  });

  it.each(ALL_STATUSES.filter((s) => s !== "executing"))(
    "is illegal from status %s",
    (status) => {
      expectIllegal(makeTask({ status }), { type: "COMPLETE_TASK" });
    }
  );
});

describe("transition() — ABORT_TASK", () => {
  it.each(ALL_STATUSES)("is legal from any status (%s) → aborted", (status) => {
    const task = makeTask({ status });
    const next = transition(task, { type: "ABORT_TASK", reason: "user cancelled" });

    expect(next.status).toBe("aborted");
    expect(next.decisionLog.at(-1)).toMatchObject({
      type: "task_aborted",
      reason: "user cancelled",
    });
  });
});

describe("transition() — unknown event", () => {
  it("throws TransitionError on an unrecognised event type", () => {
    const task = makeTask({ status: "executing" });
    expect(() => transition(task, { type: "NOPE" } as unknown as TransitionEvent)).toThrow(
      TransitionError
    );
  });
});

// ===========================================================================
// transition() — immutability & decision-log invariants
// ===========================================================================

describe("transition() — immutability & invariants", () => {
  it("never mutates the input task", () => {
    const task = makeTask({ status: "created", goal: "frozen" });
    const snapshot = structuredClone(task);

    transition(task, { type: "START_PLANNING" });

    expect(task).toEqual(snapshot);
  });

  it("returns a fresh object and a fresh decisionLog array", () => {
    const task = makeTask({ status: "created" });
    const next = transition(task, { type: "START_PLANNING" });

    expect(next).not.toBe(task);
    expect(next.decisionLog).not.toBe(task.decisionLog);
  });

  it("does not share the steps array reference when a step changes", () => {
    const task = makeTask({
      status: "executing",
      steps: [makeStep({ id: sid("s1"), status: "running" })],
    });
    const next = transition(task, { type: "COMPLETE_STEP", stepId: sid("s1") });

    expect(next.steps).not.toBe(task.steps);
    expect(next.steps[0]).not.toBe(task.steps[0]);
  });

  it("appends to the decision log without dropping prior entries", () => {
    const created = makeTask({ status: "created" });
    const planning = transition(created, { type: "START_PLANNING" }); // +task_created
    const executing = transition(planning, { type: "PLANNING_DONE" }); // no entry
    const withGate = transition(
      { ...executing, gates: [makeGate({ id: gid("g1"), status: "pending" })] },
      { type: "OPEN_GATE", gateId: gid("g1") }
    ); // +gate_opened

    expect(withGate.decisionLog.map((e) => e.type)).toEqual(["task_created", "gate_opened"]);
  });

  it("rewrites updatedAt to a valid, newer ISO timestamp", () => {
    const task = makeTask({ status: "created", updatedAt: STALE });
    const next = transition(task, { type: "START_PLANNING" });

    expect(next.updatedAt).not.toBe(STALE);
    expect(Number.isNaN(Date.parse(next.updatedAt))).toBe(false);
    expect(Date.parse(next.updatedAt)).toBeGreaterThan(Date.parse(STALE));
  });
});

// ===========================================================================
// canPush() — THE security wall
// ===========================================================================

describe("canPush() — the security wall", () => {
  const approvedPr = (id = "g-pr"): Gate =>
    makeGate({ id: gid(id), kind: "pr_approval", status: "approved", decision: "approved" });

  // ---- TRUE cases -------------------------------------------------------

  it("is true: completed task with a single approved pr_approval gate", () => {
    const task = makeTask({ status: "completed", gates: [approvedPr()] });
    expect(canPush(task)).toBe(true);
  });

  it("is true: awaiting_human task with an approved pr_approval gate (literal predicate, even if rarely reached)", () => {
    const task = makeTask({ status: "awaiting_human", gates: [approvedPr()] });
    expect(canPush(task)).toBe(true);
  });

  it("is true: multiple gates all approved, including a pr_approval", () => {
    const task = makeTask({
      status: "completed",
      gates: [
        makeGate({ id: gid("g1"), kind: "diff_review", status: "approved", decision: "approved" }),
        approvedPr("g2"),
      ],
    });
    expect(canPush(task)).toBe(true);
  });

  // ---- FALSE: wrong task status ----------------------------------------

  it.each(ALL_STATUSES.filter((s) => s !== "completed" && s !== "awaiting_human"))(
    "is false when status is %s even with an approved pr_approval gate",
    (status) => {
      const task = makeTask({ status, gates: [approvedPr()] });
      expect(canPush(task)).toBe(false);
    }
  );

  it("is false for an aborted task no matter how many gates are approved", () => {
    const task = makeTask({
      status: "aborted",
      gates: [approvedPr("a"), approvedPr("b")],
    });
    expect(canPush(task)).toBe(false);
  });

  // ---- FALSE: an unresolved gate exists --------------------------------

  it("is false when any gate is still pending", () => {
    const task = makeTask({
      status: "completed",
      gates: [approvedPr(), makeGate({ id: gid("g2"), kind: "diff_review", status: "pending" })],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false when any gate is still open", () => {
    const task = makeTask({
      status: "awaiting_human",
      gates: [approvedPr(), makeGate({ id: gid("g2"), kind: "diff_review", status: "open" })],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false when any gate decision is rejected", () => {
    const task = makeTask({
      status: "completed",
      gates: [
        approvedPr(),
        makeGate({ id: gid("g2"), kind: "diff_review", status: "rejected", decision: "rejected" }),
      ],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false when any gate decision is request_changes", () => {
    const task = makeTask({
      status: "completed",
      gates: [
        approvedPr(),
        makeGate({
          id: gid("g2"),
          kind: "diff_review",
          status: "rejected",
          decision: "request_changes",
        }),
      ],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false when the pr_approval gate itself was rejected", () => {
    const task = makeTask({
      status: "completed",
      gates: [makeGate({ id: gid("g-pr"), kind: "pr_approval", status: "rejected", decision: "rejected" })],
    });
    expect(canPush(task)).toBe(false);
  });

  // ---- FALSE: no qualifying pr_approval --------------------------------

  it("is false when there are no gates at all", () => {
    const task = makeTask({ status: "completed", gates: [] });
    expect(canPush(task)).toBe(false);
  });

  it("is false when the only approved gate is not a pr_approval", () => {
    const task = makeTask({
      status: "completed",
      gates: [makeGate({ id: gid("g1"), kind: "diff_review", status: "approved", decision: "approved" })],
    });
    expect(canPush(task)).toBe(false);
  });

  it.each(["plan_review", "diff_review"] as GateKind[])(
    "is false when an approved %s exists but no pr_approval does",
    (kind) => {
      const task = makeTask({
        status: "completed",
        gates: [makeGate({ id: gid("g1"), kind, status: "approved", decision: "approved" })],
      });
      expect(canPush(task)).toBe(false);
    }
  );

  // ---- FALSE: malformed approvals — only an explicit "approved" decision counts

  it("is false for a pr_approval with status=approved but no decision recorded (malformed)", () => {
    const task = makeTask({
      status: "completed",
      gates: [makeGate({ id: gid("g-pr"), kind: "pr_approval", status: "approved" })],
    });
    // status looks approved, but decision !== "approved" → not a real human approval.
    expect(canPush(task)).toBe(false);
  });

  it.each(["rejected", "request_changes"] as HumanDecision[])(
    "is false for a pr_approval whose decision is %s regardless of status field",
    (decision) => {
      const task = makeTask({
        status: "completed",
        gates: [makeGate({ id: gid("g-pr"), kind: "pr_approval", status: "approved", decision })],
      });
      expect(canPush(task)).toBe(false);
    }
  );

  // ---- FALSE: one bad gate poisons an otherwise-approved set ------------

  it("is false when an approved pr_approval coexists with a second open gate", () => {
    const task = makeTask({
      status: "awaiting_human",
      gates: [approvedPr(), makeGate({ id: gid("g2"), kind: "plan_review", status: "open" })],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false with two pr_approval gates when one is rejected", () => {
    const task = makeTask({
      status: "completed",
      gates: [
        approvedPr("g-ok"),
        makeGate({ id: gid("g-bad"), kind: "pr_approval", status: "rejected", decision: "rejected" }),
      ],
    });
    expect(canPush(task)).toBe(false);
  });
});

// ===========================================================================
// End-to-end: a full happy-path drive ending in canPush() === true
// ===========================================================================

describe("end-to-end happy path", () => {
  it("drives created → … → completed with an approved PR gate, then canPush() is true", () => {
    let task = makeTask({
      status: "created",
      steps: [makeStep({ id: sid("s1"), status: "pending", gateAfter: gid("g-pr") })],
      gates: [makeGate({ id: gid("g-pr"), kind: "pr_approval", status: "pending" })],
    });

    task = transition(task, { type: "START_PLANNING" });
    expect(task.status).toBe("planning");

    task = transition(task, { type: "PLANNING_DONE" });
    expect(task.status).toBe("executing");

    task = transition(task, { type: "START_STEP", stepId: sid("s1") });
    expect(task.steps[0]!.status).toBe("running");

    task = transition(task, { type: "COMPLETE_STEP", stepId: sid("s1") });
    expect(task.steps[0]!.status).toBe("blocked_on_gate");

    task = transition(task, { type: "OPEN_GATE", gateId: gid("g-pr") });
    expect(task.status).toBe("awaiting_human");
    expect(canPush(task)).toBe(false); // gate open → wall closed

    task = transition(task, { type: "DECIDE_GATE", gateId: gid("g-pr"), decision: "approved" });
    expect(task.status).toBe("executing"); // last gate cleared
    expect(canPush(task)).toBe(false); // not completed yet → wall still closed

    task = transition(task, { type: "COMPLETE_TASK" });
    expect(task.status).toBe("completed");
    expect(canPush(task)).toBe(true); // ✅ the only state where the wall opens

    // Decision log is the source of truth and reads as a coherent narrative.
    expect(task.decisionLog.map((e) => e.type)).toEqual([
      "task_created",
      "step_started",
      "step_completed",
      "gate_opened",
      "gate_decided",
      "task_completed",
    ]);
  });
});

// ===========================================================================
// canPush() — fail-closed hardening: a gate clears the wall only when BOTH its
// status AND its recorded decision are "approved". These cases all describe
// status/decision desyncs and corrupt records that must NEVER open the wall.
// ===========================================================================

describe("canPush() — fail-closed (status AND decision must both be approved)", () => {
  const okPr = (): Gate =>
    makeGate({ id: gid("g-pr"), kind: "pr_approval", status: "approved", decision: "approved" });

  it("is false: pr_approval with decision=approved but status=rejected (status/decision desync)", () => {
    const task = makeTask({
      status: "completed",
      gates: [makeGate({ id: gid("g-pr"), kind: "pr_approval", status: "rejected", decision: "approved" })],
    });
    expect(canPush(task)).toBe(false);
  });

  it.each(["open", "pending"] as GateStatus[])(
    "is false: pr_approval still %s even though decision=approved is already recorded",
    (status) => {
      const task = makeTask({
        status: "awaiting_human",
        gates: [makeGate({ id: gid("g-pr"), kind: "pr_approval", status, decision: "approved" })],
      });
      expect(canPush(task)).toBe(false);
    }
  );

  it("is false: pr_approval with an unknown/corrupt status value but decision=approved", () => {
    const task = makeTask({
      status: "completed",
      gates: [
        makeGate({
          id: gid("g-pr"),
          kind: "pr_approval",
          status: "in_review" as unknown as GateStatus, // un-migrated / future / corrupt value
          decision: "approved",
        }),
      ],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false: two pr_approval gates, the second status=rejected despite a stale decision=approved", () => {
    const task = makeTask({
      status: "completed",
      gates: [
        okPr(),
        makeGate({ id: gid("g-bad"), kind: "pr_approval", status: "rejected", decision: "approved" }),
      ],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false: a sibling gate is status=rejected with no decision (rejection seen via status, not only decision)", () => {
    const task = makeTask({
      status: "completed",
      gates: [okPr(), makeGate({ id: gid("g2"), kind: "diff_review", status: "rejected" })],
    });
    expect(canPush(task)).toBe(false);
  });

  it("is false: a sibling gate is status=approved but carries NO explicit human decision", () => {
    const task = makeTask({
      status: "completed",
      gates: [okPr(), makeGate({ id: gid("g2"), kind: "diff_review", status: "approved" })],
    });
    expect(canPush(task)).toBe(false);
  });
});

// ===========================================================================
// transition() — terminal-state guards. "completed" and "aborted" are terminal:
// the status-agnostic gate events must not be able to resurrect a finished task.
// ===========================================================================

describe("transition() — terminal-state guards", () => {
  it.each(["completed", "aborted"] as TaskStatus[])(
    "OPEN_GATE is illegal on a %s task (no resurrection to awaiting_human)",
    (status) => {
      const task = makeTask({ status, gates: [makeGate({ id: gid("g1"), status: "pending" })] });
      expectIllegal(task, { type: "OPEN_GATE", gateId: gid("g1") });
    }
  );

  it.each(["completed", "aborted"] as TaskStatus[])(
    "DECIDE_GATE is illegal on a %s task (no resurrection to executing)",
    (status) => {
      const task = makeTask({ status, gates: [makeGate({ id: gid("g1"), status: "open" })] });
      expectIllegal(task, { type: "DECIDE_GATE", gateId: gid("g1"), decision: "approved" });
    }
  );

  it.each(["completed", "aborted"] as TaskStatus[])(
    "FAIL_STEP stays status-agnostic by design: fails the step on a %s task, leaves task.status untouched",
    (status) => {
      const task = makeTask({ status, steps: [makeStep({ id: sid("s1"), status: "running" })] });
      const next = transition(task, { type: "FAIL_STEP", stepId: sid("s1"), reason: "x" });
      expect(next.steps[0]!.status).toBe("failed");
      expect(next.status).toBe(status);
    }
  );
});

// ===========================================================================
// transition() — exactly one decision-log entry per mutating event.
// Guards the append-only invariant: no event may drop, duplicate, or rewrite
// prior entries; PLANNING_DONE is the one mutating event that logs nothing.
// ===========================================================================

describe("transition() — decision-log append discipline", () => {
  const SEED: DecisionEntry = { type: "task_created", at: STALE, goal: "seed" };
  const seeded = (o: Partial<Task>): Task => makeTask({ ...o, decisionLog: [SEED] });

  const MUTATING: Array<{ name: string; task: Task; event: TransitionEvent }> = [
    { name: "START_PLANNING", task: seeded({ status: "created" }), event: { type: "START_PLANNING" } },
    {
      name: "START_STEP",
      task: seeded({ status: "executing", steps: [makeStep({ id: sid("s1"), status: "pending" })] }),
      event: { type: "START_STEP", stepId: sid("s1") },
    },
    {
      name: "COMPLETE_STEP",
      task: seeded({ status: "executing", steps: [makeStep({ id: sid("s1"), status: "running" })] }),
      event: { type: "COMPLETE_STEP", stepId: sid("s1") },
    },
    {
      name: "FAIL_STEP",
      task: seeded({ status: "executing", steps: [makeStep({ id: sid("s1"), status: "running" })] }),
      event: { type: "FAIL_STEP", stepId: sid("s1"), reason: "boom" },
    },
    {
      name: "OPEN_GATE",
      task: seeded({ status: "executing", gates: [makeGate({ id: gid("g1"), status: "pending" })] }),
      event: { type: "OPEN_GATE", gateId: gid("g1") },
    },
    {
      name: "DECIDE_GATE",
      task: seeded({ status: "awaiting_human", gates: [makeGate({ id: gid("g1"), status: "open" })] }),
      event: { type: "DECIDE_GATE", gateId: gid("g1"), decision: "approved" },
    },
    { name: "COMPLETE_TASK", task: seeded({ status: "executing" }), event: { type: "COMPLETE_TASK" } },
    { name: "ABORT_TASK", task: seeded({ status: "executing" }), event: { type: "ABORT_TASK", reason: "stop" } },
  ];

  it.each(MUTATING)("$name appends exactly one entry and preserves the prior log", ({ task, event }) => {
    const next = transition(task, event);
    expect(next.decisionLog).toHaveLength(2);
    expect(next.decisionLog[0]).toBe(task.decisionLog[0]); // prior entry kept, by reference
  });

  it("PLANNING_DONE appends no entry and returns the same log array reference", () => {
    const task = seeded({ status: "planning" });
    const next = transition(task, { type: "PLANNING_DONE" });
    expect(next.decisionLog).toHaveLength(1);
    expect(next.decisionLog).toBe(task.decisionLog);
  });
});

// ===========================================================================
// transition() — no collateral mutation of unrelated collections.
// A transition only rebuilds the collection it touches; everything else must
// pass through by reference (cheap, and proves nothing else was disturbed).
// ===========================================================================

describe("transition() — collateral collections pass through by reference", () => {
  it("a gate transition leaves the steps and artifacts arrays reference-identical", () => {
    const artifacts: Artifact[] = [
      { id: aid("a1"), kind: "pr_url", ref: "https://example.test/pr/1", producedByStep: sid("s1"), createdAt: STALE },
    ];
    const task = makeTask({
      status: "awaiting_human",
      steps: [makeStep({ id: sid("s1"), status: "running" })],
      artifacts,
      gates: [makeGate({ id: gid("g1"), status: "open" })],
    });

    const next = transition(task, { type: "DECIDE_GATE", gateId: gid("g1"), decision: "approved" });

    expect(next.steps).toBe(task.steps);
    expect(next.artifacts).toBe(task.artifacts);
  });

  it("a step transition leaves the gates and artifacts arrays reference-identical", () => {
    const artifacts: Artifact[] = [
      { id: aid("a1"), kind: "diff", ref: "change.diff", producedByStep: sid("s1"), createdAt: STALE },
    ];
    const task = makeTask({
      status: "executing",
      steps: [makeStep({ id: sid("s1"), status: "running" })],
      gates: [makeGate({ id: gid("g1"), status: "pending" })],
      artifacts,
    });

    const next = transition(task, { type: "COMPLETE_STEP", stepId: sid("s1") });

    expect(next.gates).toBe(task.gates);
    expect(next.artifacts).toBe(task.artifacts);
  });
});

// ===========================================================================
// Audit trail — log timestamps. Each appended entry's `at` must equal the
// producing transition's updatedAt, and timestamps must never go backwards.
// ===========================================================================

describe("audit trail — log timestamps", () => {
  it("every entry's `at` equals its transition's updatedAt and the log is chronologically non-decreasing", () => {
    let task = makeTask({
      status: "created",
      steps: [makeStep({ id: sid("s1"), status: "pending", gateAfter: gid("g1") })],
      gates: [makeGate({ id: gid("g1"), kind: "pr_approval", status: "pending" })],
    });

    const drive: TransitionEvent[] = [
      { type: "START_PLANNING" },
      { type: "PLANNING_DONE" }, // logs nothing
      { type: "START_STEP", stepId: sid("s1") },
      { type: "COMPLETE_STEP", stepId: sid("s1") },
      { type: "OPEN_GATE", gateId: gid("g1") },
      { type: "DECIDE_GATE", gateId: gid("g1"), decision: "approved" },
      { type: "COMPLETE_TASK" },
    ];

    for (const event of drive) {
      const before = task.decisionLog.length;
      task = transition(task, event);
      if (task.decisionLog.length > before) {
        // The entry this transition appended carries the same instant as updatedAt.
        expect(task.decisionLog.at(-1)!.at).toBe(task.updatedAt);
      }
    }

    const times = task.decisionLog.map((e) => e.at);
    expect(times).toEqual([...times].sort()); // ISO-8601 sorts chronologically
  });
});
