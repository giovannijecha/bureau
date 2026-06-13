import { z } from "zod";

export const MessageRole = z.enum(["user", "iris", "system"]);

export const MessageDto = z.object({
  id: z.string(),
  role: MessageRole,
  content: z.string(),
  taskId: z.string().optional(),
  createdAt: z.string(),
});

export const SendMessageRequestDto = z.object({
  content: z.string().min(1).max(32_000),
});

export type Message = z.infer<typeof MessageDto>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestDto>;
