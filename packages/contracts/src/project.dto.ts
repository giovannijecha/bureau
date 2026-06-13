import { z } from "zod";

// A project is one GitHub repository Bureau works on. The CEO picks the active
// project in the Assistant so Iris knows where we're working. Server-internal
// details (clone url, on-disk paths) are NOT exposed — only what the panel needs.

export const ProjectDto = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  baseBranch: z.string(),
});

export type Project = z.infer<typeof ProjectDto>;
