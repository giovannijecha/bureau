import { z } from "zod";

// WebSocket events pushed from engine → panel

export const WsEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task_updated"), taskId: z.string(), status: z.string() }),
  z.object({ type: z.literal("gate_opened"), taskId: z.string(), gateId: z.string(), gateKind: z.string() }),
  z.object({ type: z.literal("iris_message"), messageId: z.string(), content: z.string() }),
  z.object({ type: z.literal("step_started"), taskId: z.string(), stepId: z.string() }),
  z.object({ type: z.literal("step_completed"), taskId: z.string(), stepId: z.string() }),
]);

export type WsEvent = z.infer<typeof WsEventSchema>;
