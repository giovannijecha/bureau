import { z } from "zod";

// WebSocket events pushed from engine → panel

export const WsEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task_updated"), taskId: z.string(), status: z.string() }),
  z.object({ type: z.literal("gate_opened"), taskId: z.string(), gateId: z.string(), gateKind: z.string() }),
  z.object({ type: z.literal("iris_message"), messageId: z.string(), content: z.string() }),
  z.object({ type: z.literal("step_started"), taskId: z.string(), stepId: z.string() }),
  z.object({ type: z.literal("step_completed"), taskId: z.string(), stepId: z.string() }),
  // A chunk of a worker's live output as it works the step — drives the "watch the
  // agent" stream on the task detail + Hub.
  z.object({ type: z.literal("step_progress"), taskId: z.string(), stepId: z.string(), capability: z.string(), chunk: z.string() }),
  z.object({ type: z.literal("notification"), notificationId: z.string(), kind: z.string(), subject: z.string() }),
  // The project list changed (a repo was added or removed) — the panel refetches.
  z.object({ type: z.literal("projects_changed") }),
  // A compact summary of a tool Iris just invoked during a chat turn (e.g. "Read
  // src/auth.ts") — drives the live "Iris is working…" activity while a reply is pending.
  z.object({ type: z.literal("iris_activity"), summary: z.string() }),
  // The vault crossed the auto-curation threshold (N finished tasks) — the Memory page
  // surfaces a non-blocking "tidy memory?" nudge. Preview only; apply stays CEO-gated.
  z.object({ type: z.literal("curation_due"), tasksSince: z.number() }),
]);

export type WsEvent = z.infer<typeof WsEventSchema>;
