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

export type TaskSummary = z.infer<typeof TaskSummaryDto>;
export type GateDecisionRequest = z.infer<typeof GateDecisionRequestDto>;
