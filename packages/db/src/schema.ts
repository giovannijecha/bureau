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
    summary: text("summary"),
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

// A conversation between the CEO and Iris (ChatGPT-style threads). Messages belong
// to a conversation; a conversation may be scoped to the project it was started in.
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  projectId: text("project_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// The chat log between the CEO and Iris. A flat, append-only stream within a
// conversation (a message may reference a task). `seq` is an autoincrement
// insertion order so the log always reads back exactly as written, even when
// several messages share a millisecond timestamp. The role union is inlined (not
// imported from contracts) to keep db importing @bureau/core only.
export const messages = sqliteTable(
  "messages",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    // Nullable (pre-thread messages have NULL) but FK-cascaded: deleting a
    // conversation removes its messages at the DB level too.
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<"user" | "iris" | "system">(),
    content: text("content").notNull(),
    taskId: text("task_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("messages_by_seq").on(t.seq), index("messages_by_conversation").on(t.conversationId, t.seq)]
);

// Token-usage events — append-only, for the Usage & Cost metrics. Each provider
// round-trip (Iris chat, or a capability worker) records what it spent. Standalone
// (no FK to tasks): spend history must outlive a task, and `task_id` is a soft
// reference. `scope` is 'iris' or a capability kind; `day` (UTC YYYY-MM-DD) keys
// the time series.
export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    day: text("day").notNull(),
    scope: text("scope").notNull(),
    taskId: text("task_id"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("usage_by_day").on(t.day)]
);

// CEO notifications — durable, engine→CEO signals generated at real lifecycle
// moments (a review gate opening, a task failing, a merge landing/failing). Unlike
// the ephemeral WS events, these survive a reload so an approval is never missed.
// `read_at` is NULL until acknowledged.
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    taskId: text("task_id"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
    readAt: text("read_at"),
  },
  (t) => [index("notifications_by_created").on(t.createdAt)]
);

export const schema = { tasks, steps, gates, artifacts, decisionLog, conversations, messages, usageEvents, notifications };
