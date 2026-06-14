import { z } from "zod";

export const MessageRole = z.enum(["user", "iris", "system"]);

export const MessageDto = z.object({
  id: z.string(),
  role: MessageRole,
  content: z.string(),
  taskId: z.string().optional(),
  conversationId: z.string().optional(),
  createdAt: z.string(),
});

export const SendMessageRequestDto = z.object({
  content: z
    .string()
    .min(1)
    .max(32_000)
    .refine((s) => s.trim().length > 0, { message: "content cannot be empty or whitespace-only" }),
  /** Which project the conversation is about (defaults to the first project). */
  projectId: z.string().optional(),
  /** Which conversation to append to (a new one is created when omitted). */
  conversationId: z.string().optional(),
});

export type Message = z.infer<typeof MessageDto>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestDto>;
