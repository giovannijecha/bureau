import { z } from "zod";
import { CapabilitySchema, TaskSummaryDto } from "./task.dto.js";

// The Agent-Activity Hub: a live "work floor" over Bureau's capability workers,
// animated by the steps running across every task + a cross-task activity feed.

/** One capability worker's live status — derived from the registry (implemented?)
 *  and a scan of every task's steps (is one running right now?). */
export const WorkerStatusDto = z.object({
  capability: CapabilitySchema,
  /** The worker persona (Editor, Scribe, …). */
  assignee: z.string(),
  /** Whether this capability is actually built (registered), not just declared. */
  implemented: z.boolean(),
  /** True when at least one task has a running step of this capability. */
  live: z.boolean(),
  /** How many steps of this capability are running right now, across all tasks. */
  runningStepCount: z.number().int().nonnegative(),
});

/** One entry in the company-wide activity feed — a flattened task decision-log row. */
export const ActivityDto = z.object({
  id: z.string(),
  /** The decision-log entry type (drives the icon/colour): step_started, gate_opened, … */
  kind: z.string(),
  taskId: z.string(),
  taskGoal: z.string(),
  at: z.string(),
  label: z.string(),
});

/** Everything the Hub renders, in one fetch. */
export const HubDto = z.object({
  workers: z.array(WorkerStatusDto),
  activity: z.array(ActivityDto),
  /** Tasks parked at an open review gate — "waiting on you". */
  awaitingReview: z.array(TaskSummaryDto),
  stats: z.object({
    activeTasks: z.number().int().nonnegative(),
    awaitingReview: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
  }),
});

export type WorkerStatus = z.infer<typeof WorkerStatusDto>;
export type Activity = z.infer<typeof ActivityDto>;
export type Hub = z.infer<typeof HubDto>;
