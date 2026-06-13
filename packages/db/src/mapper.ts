// Mapper — the trust boundary between persisted rows and the pure core domain.
// `taskToRows` flattens a Task aggregate into table rows; `rowsToTask`
// reconstructs an exact, deep-equal Task. Optional domain fields are OMITTED
// (not set to undefined) so the round-trip is faithful under
// exactOptionalPropertyTypes.

import type {
  Task,
  TaskId,
  Step,
  StepId,
  Gate,
  GateId,
  Artifact,
  ArtifactId,
  DecisionEntry,
} from "@bureau/core";
import { tasks, steps, gates, artifacts, decisionLog } from "./schema.js";

type TaskInsert = typeof tasks.$inferInsert;
type StepInsert = typeof steps.$inferInsert;
type GateInsert = typeof gates.$inferInsert;
type ArtifactInsert = typeof artifacts.$inferInsert;
type DecisionInsert = typeof decisionLog.$inferInsert;

type TaskSelect = typeof tasks.$inferSelect;
type StepSelect = typeof steps.$inferSelect;
type GateSelect = typeof gates.$inferSelect;
type ArtifactSelect = typeof artifacts.$inferSelect;
type DecisionSelect = typeof decisionLog.$inferSelect;

export interface TaskRowBundle {
  task: TaskInsert;
  steps: StepInsert[];
  gates: GateInsert[];
  artifacts: ArtifactInsert[];
  decisionLog: DecisionInsert[];
}

export interface TaskRowSelection {
  task: TaskSelect;
  steps: StepSelect[];
  gates: GateSelect[];
  artifacts: ArtifactSelect[];
  decisionLog: DecisionSelect[];
}

// ---------------------------------------------------------------------------
// Task -> rows
// ---------------------------------------------------------------------------

export function taskToRows(task: Task): TaskRowBundle {
  return {
    task: {
      id: task.id,
      goal: task.goal,
      repoOwner: task.repoOwner,
      repoName: task.repoName,
      worktreePath: task.worktreePath ?? null,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    steps: task.steps.map((s, i) => ({
      id: s.id,
      taskId: task.id,
      orderIdx: i,
      capability: s.capability,
      description: s.description,
      status: s.status,
      acceptanceCriteria: [...s.acceptanceCriteria],
      artifactIds: [...s.artifactIds],
      gateAfter: s.gateAfter ?? null,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      failureReason: s.failureReason ?? null,
    })),
    gates: task.gates.map((g, i) => ({
      id: g.id,
      taskId: task.id,
      orderIdx: i,
      kind: g.kind,
      status: g.status,
      decidedAt: g.decidedAt ?? null,
      decision: g.decision ?? null,
      notes: g.notes ?? null,
    })),
    artifacts: task.artifacts.map((a, i) => ({
      id: a.id,
      taskId: task.id,
      orderIdx: i,
      kind: a.kind,
      ref: a.ref,
      producedByStep: a.producedByStep,
      createdAt: a.createdAt,
    })),
    decisionLog: task.decisionLog.map((e, i) => decisionEntryToRow(task.id, i, e)),
  };
}

function decisionEntryToRow(taskId: TaskId, orderIdx: number, e: DecisionEntry): DecisionInsert {
  const base = {
    taskId,
    orderIdx,
    type: e.type,
    at: e.at,
    goal: null,
    stepId: null,
    gateId: null,
    decision: null,
    notes: null,
    reason: null,
  } satisfies DecisionInsert;

  switch (e.type) {
    case "task_created":
      return { ...base, goal: e.goal };
    case "step_started":
    case "step_completed":
      return { ...base, stepId: e.stepId };
    case "step_failed":
      return { ...base, stepId: e.stepId, reason: e.reason };
    case "gate_opened":
      return { ...base, gateId: e.gateId };
    case "gate_decided":
      return { ...base, gateId: e.gateId, decision: e.decision, notes: e.notes ?? null };
    case "task_completed":
      return base;
    case "task_aborted":
      return { ...base, reason: e.reason };
  }
}

// ---------------------------------------------------------------------------
// rows -> Task
// ---------------------------------------------------------------------------

export function rowsToTask(b: TaskRowSelection): Task {
  const byOrder = <T extends { orderIdx: number }>(rows: T[]): T[] =>
    [...rows].sort((a, z) => a.orderIdx - z.orderIdx);

  return {
    id: b.task.id as TaskId,
    goal: b.task.goal,
    repoOwner: b.task.repoOwner,
    repoName: b.task.repoName,
    ...(b.task.worktreePath !== null ? { worktreePath: b.task.worktreePath } : {}),
    status: b.task.status,
    steps: byOrder(b.steps).map(rowToStep),
    gates: byOrder(b.gates).map(rowToGate),
    artifacts: byOrder(b.artifacts).map(rowToArtifact),
    decisionLog: byOrder(b.decisionLog).map(rowToDecisionEntry),
    createdAt: b.task.createdAt,
    updatedAt: b.task.updatedAt,
  };
}

function rowToStep(r: StepSelect): Step {
  return {
    id: r.id as StepId,
    capability: r.capability,
    description: r.description,
    acceptanceCriteria: r.acceptanceCriteria,
    status: r.status,
    artifactIds: r.artifactIds as ArtifactId[],
    ...(r.gateAfter !== null ? { gateAfter: r.gateAfter as GateId } : {}),
    ...(r.startedAt !== null ? { startedAt: r.startedAt } : {}),
    ...(r.completedAt !== null ? { completedAt: r.completedAt } : {}),
    ...(r.failureReason !== null ? { failureReason: r.failureReason } : {}),
  };
}

function rowToGate(r: GateSelect): Gate {
  return {
    id: r.id as GateId,
    kind: r.kind,
    status: r.status,
    ...(r.decidedAt !== null ? { decidedAt: r.decidedAt } : {}),
    ...(r.decision !== null ? { decision: r.decision } : {}),
    ...(r.notes !== null ? { notes: r.notes } : {}),
  };
}

function rowToArtifact(r: ArtifactSelect): Artifact {
  return {
    id: r.id as ArtifactId,
    kind: r.kind,
    ref: r.ref,
    producedByStep: r.producedByStep as StepId,
    createdAt: r.createdAt,
  };
}

function rowToDecisionEntry(r: DecisionSelect): DecisionEntry {
  // Fail loud on a known type whose required variant column is NULL — a corrupt
  // or partially-migrated audit row must not be reconstructed into a type-lying
  // DecisionEntry that a downstream consumer would mis-render or crash on.
  const req = <T>(value: T | null, column: string): T => {
    if (value === null) {
      throw new Error(`Corrupt decision_log row (type "${r.type}"): missing required column "${column}"`);
    }
    return value;
  };

  switch (r.type) {
    case "task_created":
      return { type: "task_created", at: r.at, goal: req(r.goal, "goal") };
    case "step_started":
      return { type: "step_started", at: r.at, stepId: req(r.stepId, "step_id") as StepId };
    case "step_completed":
      return { type: "step_completed", at: r.at, stepId: req(r.stepId, "step_id") as StepId };
    case "step_failed":
      return {
        type: "step_failed",
        at: r.at,
        stepId: req(r.stepId, "step_id") as StepId,
        reason: req(r.reason, "reason"),
      };
    case "gate_opened":
      return { type: "gate_opened", at: r.at, gateId: req(r.gateId, "gate_id") as GateId };
    case "gate_decided":
      return {
        type: "gate_decided",
        at: r.at,
        gateId: req(r.gateId, "gate_id") as GateId,
        decision: req(r.decision, "decision"),
        ...(r.notes !== null ? { notes: r.notes } : {}),
      };
    case "task_completed":
      return { type: "task_completed", at: r.at };
    case "task_aborted":
      return { type: "task_aborted", at: r.at, reason: req(r.reason, "reason") };
    default:
      // A row whose type is outside the known union — corrupt or un-migrated.
      throw new Error(`Unknown decision_log entry type: ${String(r.type)}`);
  }
}
