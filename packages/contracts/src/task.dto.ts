import { z } from "zod";

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

/** Full task view for the Assistant panel: summary + gates + the diff + PR url. */
export const TaskDetailDto = TaskSummaryDto.extend({
  diff: z.string().nullable(),
  prUrl: z.string().nullable(),
  worktreePath: z.string().optional(),
  gates: z.array(GateViewDto),
});

export type TaskSummary = z.infer<typeof TaskSummaryDto>;
export type GateDecisionRequest = z.infer<typeof GateDecisionRequestDto>;
export type GateView = z.infer<typeof GateViewDto>;
export type TaskDetail = z.infer<typeof TaskDetailDto>;
