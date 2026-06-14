import { z } from "zod";

// A ChatGPT-style conversation thread between the CEO and Iris.
export const ConversationDto = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Conversation = z.infer<typeof ConversationDto>;
