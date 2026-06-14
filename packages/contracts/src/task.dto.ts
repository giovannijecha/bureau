import { z } from "zod";
import { MessageDto } from "./message.dto.js";

export const CapabilitySchema = z.enum(["plan", "edit", "test", "review", "document"]);
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
});

/** Engine status for the Settings panel. */
export const EngineInfoDto = z.object({
  provider: z.object({ name: z.string(), available: z.boolean() }),
  projectCount: z.number().int().nonnegative(),
  inflightTasks: z.number().int().nonnegative(),
});
export type EngineInfo = z.infer<typeof EngineInfoDto>;

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
});

/** A change Iris proposes in chat — a pipeline of steps the CEO can create as a task. */
export const TaskProposalDto = z.object({
  title: z.string(),
  summary: z.string(),
  steps: z.array(z.object({ capability: CapabilitySchema, description: z.string() })).min(1),
});

/** Iris's reply to a chat turn, optionally carrying a task proposal. */
export const ChatResponseDto = z.object({
  reply: MessageDto,
  /** The conversation this turn belongs to (created on the fly when none was given). */
  conversationId: z.string(),
  proposal: TaskProposalDto.optional(),
});

export const CreateTaskRequestDto = z.object({
  proposal: TaskProposalDto,
  /** Which project to create the task in (defaults to the first project). */
  projectId: z.string().optional(),
});

export type TaskSummary = z.infer<typeof TaskSummaryDto>;
export type GateDecisionRequest = z.infer<typeof GateDecisionRequestDto>;
export type GateView = z.infer<typeof GateViewDto>;
export type TaskDetail = z.infer<typeof TaskDetailDto>;
export type PipelineStep = z.infer<typeof PipelineStepDto>;
export type TaskProposal = z.infer<typeof TaskProposalDto>;
export type ChatResponse = z.infer<typeof ChatResponseDto>;
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestDto>;
