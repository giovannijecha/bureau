import { z } from "zod";

// CEO notifications — durable engine→CEO signals at lifecycle moments. `kind`
// drives the icon/colour; `review` notifications carry an inline review action.
export const NotificationKindSchema = z.enum(["review", "merged", "failed", "merge_failed"]);

export const NotificationDto = z.object({
  id: z.string(),
  kind: NotificationKindSchema,
  taskId: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** ISO timestamp when acknowledged, or null while unread. */
  readAt: z.string().nullable(),
});

export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export type Notification = z.infer<typeof NotificationDto>;
