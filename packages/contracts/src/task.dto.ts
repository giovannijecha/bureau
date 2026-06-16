import { z } from "zod";
import { MessageDto } from "./message.dto.js";
import { GitOpRequestDto } from "./git-op.dto.js";

export const CapabilitySchema = z.enum(["plan", "edit", "test", "review", "document", "research"]);
export const StepStatusSchema = z.enum(["pending", "running", "completed", "failed", "blocked_on_gate"]);

export const TaskStatusSchema = z.enum([
  "created",
  "planning",
  "executing",
  "awaiting_human",
  "completed",
  "aborted",
]);

export const GateDecisionSchema = z.enum(["approved", "rejected", "request_changes"]);

export const TaskSummaryDto = z.object({
  id: z.string(),
  goal: z.string(),
  status: TaskStatusSchema,
  repoOwner: z.string(),
  repoName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stepCount: z.number().int().nonnegative(),
  completedStepCount: z.number().int().nonnegative(),
  pendingGates: z.number().int().nonnegative(),
  /** True only when the task genuinely landed on main (completed + PR + no merge error). */
  merged: z.boolean(),
  /** True when the branch was pushed + a PR opened for review, but NOT merged — the
   *  branch lives on GitHub for the CEO to test and merge there. */
  prOpen: z.boolean(),
});

export const GateDecisionRequestDto = z.object({
  decision: GateDecisionSchema,
  notes: z.string().optional(),
});

export const GateKindSchema = z.enum(["plan_review", "diff_review", "pr_approval"]);
export const GateStatusSchema = z.enum(["pending", "open", "approved", "rejected"]);

export const GateViewDto = z.object({
  id: z.string(),
  kind: GateKindSchema,
  status: GateStatusSchema,
  decision: GateDecisionSchema.optional(),
});

/** One step in a task's pipeline (panel view), with its worker persona. */
export const PipelineStepDto = z.object({
  id: z.string(),
  capability: CapabilitySchema,
  assignee: z.string(),
  description: z.string(),
  status: StepStatusSchema,
  /** Why this step failed, when it did. */
  failureReason: z.string().nullable(),
  /** The worker's own report of what it did (persisted), or null. */
  summary: z.string().nullable(),
  /** When the worker began / finished this step (ISO-8601), or null if not yet. */
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/** One row in a task's timeline — a flattened decision-log entry with a timestamp.
 *  Captures the full history including re-run cycles (gate_reopened entries). */
export const TimelineEntryDto = z.object({
  /** The decision-log entry type (drives the icon): step_started, gate_reopened, … */
  type: z.string(),
  at: z.string(),
  label: z.string(),
});

/** Engine status for the Settings panel. */
export const EngineInfoDto = z.object({
  provider: z.object({ name: z.string(), available: z.boolean() }),
  projectCount: z.number().int().nonnegative(),
  inflightTasks: z.number().int().nonnegative(),
  /** The model each scope runs on (scope → model id): "iris" + each worker capability. */
  models: z.record(z.string(), z.string()),
});
export type EngineInfo = z.infer<typeof EngineInfoDto>;

/** Settings write: set the model for one or more scopes (the engine validates each id). */
export const SetModelsRequestDto = z.object({
  models: z.record(z.string(), z.string()),
});
export type SetModelsRequest = z.infer<typeof SetModelsRequestDto>;

/** Full task view for the Assistant panel: summary + pipeline + gates + diff + PR.
 *  Deliberately omits on-disk paths (e.g. worktreePath) — the panel never needs
 *  them and they shouldn't leave the engine. */
export const TaskDetailDto = TaskSummaryDto.extend({
  diff: z.string().nullable(),
  prUrl: z.string().nullable(),
  /** A human-readable note when the task stopped (abort reason / failed step). */
  statusNote: z.string().nullable(),
  /** Why a confirmed merge didn't land (conflicts, branch protection), or null. */
  mergeError: z.string().nullable(),
  steps: z.array(PipelineStepDto),
  gates: z.array(GateViewDto),
  /** The full event history (newest last) — substeps, gates, and re-run cycles. */
  timeline: z.array(TimelineEntryDto),
});

/** A change Iris proposes in chat — a pipeline of steps the CEO can create as a task. */
export const TaskProposalDto = z.object({
  title: z.string(),
  summary: z.string(),
  steps: z.array(z.object({ capability: CapabilitySchema, description: z.string() })).min(1),
});

/** Iris's reply to a chat turn. She may carry ONE actionable proposal: a task (a
 *  pipeline that changes repo CONTENT) or a git-op (a branch/tag/history ADMIN action
 *  the CEO authorizes inline — runs through the same gated /api/git/op endpoint). */
export const ChatResponseDto = z.object({
  reply: MessageDto,
  /** The conversation this turn belongs to (created on the fly when none was given). */
  conversationId: z.string(),
  proposal: TaskProposalDto.optional(),
  /** A git history/branch/tag operation Iris proposes — the CEO authorizes (and, for
   *  destructive ops, type-to-confirms) it inline; the panel never auto-runs it. */
  gitOp: GitOpRequestDto.optional(),
});

export const CreateTaskRequestDto = z.object({
  proposal: TaskProposalDto,
  /** Which project to create the task in (defaults to the first project). */
  projectId: z.string().optional(),
});

export type TaskSummary = z.infer<typeof TaskSummaryDto>;
export type GateDecisionRequest = z.infer<typeof GateDecisionRequestDto>;
export type GateView = z.infer<typeof GateViewDto>;
export type TimelineEntry = z.infer<typeof TimelineEntryDto>;
export type TaskDetail = z.infer<typeof TaskDetailDto>;
export type PipelineStep = z.infer<typeof PipelineStepDto>;
export type TaskProposal = z.infer<typeof TaskProposalDto>;
export type ChatResponse = z.infer<typeof ChatResponseDto>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestDto>;
