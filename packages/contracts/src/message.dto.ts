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

/** A file the CEO attaches to a chat message. Text files are inlined into Iris's
 *  context; images are saved so the agent can VIEW them with its Read tool. */
export const AttachmentDto = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(["text", "image"]),
  /** Text: the file's UTF-8 content (≤256 KB). Image: base64 bytes (≤10 MB), no data: prefix. */
  content: z.string().max(14_000_000),
  /** Image media type, e.g. "image/png" (required for images, ignored for text). */
  mediaType: z.string().max(100).optional(),
});

export const SendMessageRequestDto = z
  .object({
    content: z.string().max(32_000).default(""),
    /** Which project the conversation is about (defaults to the first project). */
    projectId: z.string().optional(),
    /** Which conversation to append to (a new one is created when omitted). */
    conversationId: z.string().optional(),
    /** Files attached to this turn (images + text). */
    attachments: z.array(AttachmentDto).max(8).optional(),
  })
  // A turn needs SOMETHING to say — typed text or at least one attachment.
  .refine((d) => d.content.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: "Provide a message or at least one attachment.",
  });

export type Attachment = z.infer<typeof AttachmentDto>;
export type Message = z.infer<typeof MessageDto>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestDto>;
