// Drizzle schema — the persisted shape of the Task aggregate (core types).
//
// Design notes:
// - Queryable entities (tasks, steps, gates, artifacts) are normalised, each
//   child carrying an `order_idx` so the domain array order round-trips exactly.
// - `decision_log` is a normalised table because it IS the audit trail (the
//   "state is the truth" backbone); the union's variant fields are nullable
//   columns, reconstructed by `type` on load.
// - Step-local lists that are never queried on their own — `acceptanceCriteria`
//   and `artifactIds` — are stored as JSON columns on `steps`. Lean and faithful,
//   no extra child tables.
//
// db imports @bureau/core ONLY (golden rule). All imports here are type-only.

import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";
import type {
  TaskStatus,
  StepStatus,
  CapabilityKind,
  GateKind,
  GateStatus,
  HumanDecision,
  ArtifactKind,
  AcceptanceCriterion,
  DecisionEntry,
} from "@bureau/core";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  goal: text("goal").notNull(),
  projectId: text("project_id"),
  repoOwner: text("repo_owner").notNull(),
  repoName: text("repo_name").notNull(),
  worktreePath: text("worktree_path"),
  status: text("status").notNull().$type<TaskStatus>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Child ids are scoped to their task: the primary key is (task_id, id), not id
// alone. The Task is the aggregate root, so step/gate/artifact ids only need to
// be unique within a task — two tasks can both have a step "s1" without the
// engine minting globally-unique ids. (decision_log is keyed the same way.)
export const steps = sqliteTable(
  "steps",
  {
    id: text("id").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    orderIdx: integer("order_idx").notNull(),
    capability: text("capability").notNull().$type<CapabilityKind>(),
    description: text("description").notNull(),
    status: text("status").notNull().$type<StepStatus>(),
    acceptanceCriteria: text("acceptance_criteria", { mode: "json" })
      .notNull()
      .$type<AcceptanceCriterion[]>(),
    artifactIds: text("artifact_ids", { mode: "json" }).notNull().$type<string[]>(),
    gateAfter: text("gate_after"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    failureReason: text("failure_reason"),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.id] }), index("steps_by_task").on(t.taskId, t.orderIdx)]
);

export const gates = sqliteTable(
  "gates",
  {
    id: text("id").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    orderIdx: integer("order_idx").notNull(),
    kind: text("kind").notNull().$type<GateKind>(),
    status: text("status").notNull().$type<GateStatus>(),
    decidedAt: text("decided_at"),
    decision: text("decision").$type<HumanDecision>(),
    notes: text("notes"),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.id] }), index("gates_by_task").on(t.taskId, t.orderIdx)]
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    orderIdx: integer("order_idx").notNull(),
    kind: text("kind").notNull().$type<ArtifactKind>(),
    ref: text("ref").notNull(),
    producedByStep: text("produced_by_step").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.id] }), index("artifacts_by_task").on(t.taskId, t.orderIdx)]
);

export const decisionLog = sqliteTable(
  "decision_log",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    orderIdx: integer("order_idx").notNull(),
    type: text("type").notNull().$type<DecisionEntry["type"]>(),
    at: text("at").notNull(),
    // Variant fields — each present only for the entry types that carry them.
    goal: text("goal"),
    stepId: text("step_id"),
    gateId: text("gate_id"),
    decision: text("decision").$type<HumanDecision>(),
    notes: text("notes"),
    reason: text("reason"),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.orderIdx] })]
);

// The chat log between the CEO and Iris. Not part of the Task aggregate — it's a
// flat, append-only stream (a message may reference a task). `seq` is an
// autoincrement insertion order so the log always reads back exactly as written,
// even when several messages share a millisecond timestamp. The role union is
// inlined (not imported from contracts) to keep db importing @bureau/core only.
export const messages = sqliteTable(
  "messages",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    role: text("role").notNull().$type<"user" | "iris" | "system">(),
    content: text("content").notNull(),
    taskId: text("task_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("messages_by_seq").on(t.seq)]
);

export const schema = { tasks, steps, gates, artifacts, decisionLog, messages };
