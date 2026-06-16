// State machine for Task — pure, unit-testable, zero I/O.
// canPush() is THE security wall: push/openPr are only ever called after this returns true.

import type {
  Task,
  TaskStatus,
  Step,
  StepId,
  Gate,
  GateId,
  HumanDecision,
  DecisionEntry,
} from "./task.js";

// ---------------------------------------------------------------------------
// Transition events (discriminated union)
// ---------------------------------------------------------------------------

export type TransitionEvent =
  | { type: "START_PLANNING" }
  | { type: "PLANNING_DONE" }
  | { type: "START_STEP"; stepId: StepId }
  | { type: "COMPLETE_STEP"; stepId: StepId; summary?: string }
  | { type: "FAIL_STEP"; stepId: StepId; reason: string }
  | { type: "OPEN_GATE"; gateId: GateId }
  | { type: "DECIDE_GATE"; gateId: GateId; decision: HumanDecision; notes?: string }
  | { type: "REOPEN_FOR_CHANGES"; gateId: GateId }
  | { type: "COMPLETE_TASK" }
  | { type: "ABORT_TASK"; reason: string };

// ---------------------------------------------------------------------------
// Transition errors
// ---------------------------------------------------------------------------

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

// ---------------------------------------------------------------------------
// canPush — THE security wall
// A task may push/openPr only when ALL of the following hold:
//   1. status is "awaiting_human" (all steps done, final gate open) or "completed"
//   2. EVERY gate is affirmatively approved — status === "approved" AND a recorded
//      human decision === "approved"
//   3. at least one of those approved gates is of kind "pr_approval"
//
// This predicate is FAIL-CLOSED on purpose: it runs over whatever shape the DB
// hands back (the state is the truth), so it must never grant a push on a
// gate that is merely "not obviously rejected". A gate that is pending, open,
// rejected, request_changes, missing its decision, or carrying any unknown /
// corrupt status value does NOT clear the wall. Only an explicit, two-sided
// approval counts.
// ---------------------------------------------------------------------------

export function canPush(task: Task): boolean {
  if (task.status !== "awaiting_human" && task.status !== "completed") {
    return false;
  }
  // Every gate must be affirmatively approved on BOTH its lifecycle status and
  // its recorded human decision. `every` over an empty gate list is true, which
  // is then correctly rejected by the pr_approval check below.
  const everyGateApproved = task.gates.every(
    (g) => g.status === "approved" && g.decision === "approved"
  );
  if (!everyGateApproved) return false;

  // …and at least one of those approved gates must be the PR approval itself.
  return task.gates.some((g) => g.kind === "pr_approval");
}

// ---------------------------------------------------------------------------
// transition — immutable update; returns a new Task or throws TransitionError
// ---------------------------------------------------------------------------

export function transition(task: Task, event: TransitionEvent): Task {
  const now = new Date().toISOString();

  switch (event.type) {
    case "START_PLANNING":
      assertStatus(task, "created", event.type);
      return patch(task, now, { status: "planning" }, {
        type: "task_created",
        at: now,
        goal: task.goal,
      } satisfies DecisionEntry);

    case "PLANNING_DONE":
      assertStatus(task, "planning", event.type);
      return patch(task, now, { status: "executing" });

    case "START_STEP": {
      assertStatus(task, "executing", event.type);
      const step = requireStep(task, event.stepId);
      if (step.status !== "pending") {
        throw new TransitionError(`Step ${event.stepId} is not pending (status: ${step.status})`);
      }
      return patchStep(task, now, event.stepId, { status: "running", startedAt: now }, {
        type: "step_started",
        at: now,
        stepId: event.stepId,
      });
    }

    case "COMPLETE_STEP": {
      assertStatus(task, "executing", event.type);
      const step = requireStep(task, event.stepId);
      if (step.status !== "running") {
        throw new TransitionError(`Step ${event.stepId} is not running (status: ${step.status})`);
      }
      return patchStep(task, now, event.stepId, {
        status: step.gateAfter ? "blocked_on_gate" : "completed",
        completedAt: now,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      }, {
        type: "step_completed",
        at: now,
        stepId: event.stepId,
      });
    }

    case "FAIL_STEP": {
      const step = requireStep(task, event.stepId);
      if (step.status !== "running") {
        throw new TransitionError(`Step ${event.stepId} is not running (status: ${step.status})`);
      }
      return patchStep(task, now, event.stepId, {
        status: "failed",
        failureReason: event.reason,
        completedAt: now,
      }, {
        type: "step_failed",
        at: now,
        stepId: event.stepId,
        reason: event.reason,
      });
    }

    case "OPEN_GATE": {
      assertNotTerminal(task, event.type);
      const gate = requireGate(task, event.gateId);
      if (gate.status !== "pending") {
        throw new TransitionError(`Gate ${event.gateId} is not pending (status: ${gate.status})`);
      }
      return patchGate(task, now, event.gateId, { status: "open" }, {
        type: "gate_opened",
        at: now,
        gateId: event.gateId,
      }, "awaiting_human");
    }

    case "DECIDE_GATE": {
      assertNotTerminal(task, event.type);
      const gate = requireGate(task, event.gateId);
      if (gate.status !== "open") {
        throw new TransitionError(`Gate ${event.gateId} is not open (status: ${gate.status})`);
      }
      const gateStatus = event.decision === "approved" ? "approved" : "rejected";
      const newGate = patchGate(task, now, event.gateId, {
        status: gateStatus,
        decision: event.decision,
        decidedAt: now,
        ...(event.notes !== undefined ? { notes: event.notes } : {}),
      }, {
        type: "gate_decided",
        at: now,
        gateId: event.gateId,
        decision: event.decision,
        ...(event.notes !== undefined ? { notes: event.notes } : {}),
      });
      // If approved and no more open gates, resume executing
      const stillAwaiting = newGate.gates.some((g) => g.status === "open" || g.status === "pending");
      if (event.decision === "approved" && !stillAwaiting) {
        return { ...newGate, status: "executing", updatedAt: now };
      }
      return newGate;
    }

    case "REOPEN_FOR_CHANGES": {
      // The CEO asked for changes (a request_changes decision). Re-open the loop:
      // reset the gate + its step to pending and resume executing so the worker
      // revises the diff. ONLY legal on a gate the CEO marked request_changes —
      // a plain "rejected" gate stays terminal, so reject can never be re-run.
      assertNotTerminal(task, event.type);
      assertStatus(task, "awaiting_human", event.type);
      const gate = requireGate(task, event.gateId);
      if (gate.status !== "rejected" || gate.decision !== "request_changes") {
        throw new TransitionError(
          `Gate ${event.gateId} is not awaiting changes (status: ${gate.status}, decision: ${gate.decision ?? "none"})`
        );
      }
      // Rebuild the gate + EVERY step as FRESH objects (omit decision/decidedAt/
      // notes, startedAt/completedAt/summary/failureReason) so the whole pipeline
      // re-runs with the CEO's feedback, and no stale decision can ever survive
      // into a later canPush() check — under exactOptionalPropertyTypes, omitted ≠
      // undefined. The whole pipeline (not just the gated step) re-runs: a change
      // request is about the overall diff, and re-running only the last step would
      // re-run the read-only review, not the edit that produced the change.
      const resetGate: Gate = { id: gate.id, kind: gate.kind, status: "pending" };
      const resetStep = (s: Step): Step => ({
        id: s.id,
        capability: s.capability,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
        status: "pending",
        ...(s.gateAfter !== undefined ? { gateAfter: s.gateAfter } : {}),
        artifactIds: s.artifactIds,
      });
      return {
        ...task,
        status: "executing",
        updatedAt: now,
        gates: task.gates.map((g) => (g.id === gate.id ? resetGate : g)),
        steps: task.steps.map(resetStep),
        decisionLog: [...task.decisionLog, { type: "gate_reopened", at: now, gateId: gate.id }],
      };
    }

    case "COMPLETE_TASK": {
      assertStatus(task, "executing", event.type);
      // A step that ran and parked at its (now-approved) gate is accepted as the task
      // completes — mark it completed so step counts and timelines are honest, not "0/1".
      const completedSteps = task.steps.map((s) =>
        s.status === "blocked_on_gate" ? { ...s, status: "completed" as const, completedAt: s.completedAt ?? now } : s
      );
      return patch({ ...task, steps: completedSteps }, now, { status: "completed" }, {
        type: "task_completed",
        at: now,
      } satisfies DecisionEntry);
    }

    case "ABORT_TASK":
      // Aborting also terminalises any in-flight step, so a stopped task never
      // carries a perpetually "running" step (which the panel would render as a
      // spinner on a dead task). The step's failure reason is the abort reason.
      return {
        ...patch(task, now, { status: "aborted" }, {
          type: "task_aborted",
          at: now,
          reason: event.reason,
        } satisfies DecisionEntry),
        steps: task.steps.map((s) =>
          s.status === "running"
            ? { ...s, status: "failed", failureReason: event.reason, completedAt: now }
            : s
        ),
      };

    default: {
      const _exhaustive: never = event;
      throw new TransitionError(`Unknown event: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

function assertStatus(task: Task, expected: TaskStatus, eventType: string): void {
  if (task.status !== expected) {
    throw new TransitionError(
      `Event ${eventType} requires status "${expected}", but task is "${task.status}"`
    );
  }
}

/**
 * Guard for the status-agnostic gate events (OPEN_GATE / DECIDE_GATE): a
 * "completed" or "aborted" task is terminal and must not be resurrected. Without
 * this, a leftover gate could drag a finished task back into awaiting_human /
 * executing — and awaiting_human is one of the two states canPush() accepts.
 */
function assertNotTerminal(task: Task, eventType: string): void {
  if (task.status === "completed" || task.status === "aborted") {
    throw new TransitionError(
      `Event ${eventType} is not allowed on a "${task.status}" task (terminal state)`
    );
  }
}

function requireStep(task: Task, stepId: StepId): Step {
  const step = task.steps.find((s) => s.id === stepId);
  if (!step) throw new TransitionError(`Step ${stepId} not found in task ${task.id}`);
  return step;
}

function requireGate(task: Task, gateId: GateId): Gate {
  const gate = task.gates.find((g) => g.id === gateId);
  if (!gate) throw new TransitionError(`Gate ${gateId} not found in task ${task.id}`);
  return gate;
}

function patch(
  task: Task,
  now: string,
  updates: Partial<Task>,
  entry?: DecisionEntry
): Task {
  return {
    ...task,
    ...updates,
    updatedAt: now,
    decisionLog: entry ? [...task.decisionLog, entry] : task.decisionLog,
  };
}

function patchStep(
  task: Task,
  now: string,
  stepId: StepId,
  stepUpdates: Partial<Step>,
  entry: DecisionEntry
): Task {
  return {
    ...task,
    updatedAt: now,
    steps: task.steps.map((s) => (s.id === stepId ? { ...s, ...stepUpdates } : s)),
    decisionLog: [...task.decisionLog, entry],
  };
}

function patchGate(
  task: Task,
  now: string,
  gateId: GateId,
  gateUpdates: Partial<Gate>,
  entry: DecisionEntry,
  newStatus?: TaskStatus
): Task {
  return {
    ...task,
    updatedAt: now,
    ...(newStatus ? { status: newStatus } : {}),
    gates: task.gates.map((g) => (g.id === gateId ? { ...g, ...gateUpdates } : g)),
    decisionLog: [...task.decisionLog, entry],
  };
}
