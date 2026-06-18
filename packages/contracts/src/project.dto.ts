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

// Add a project from the panel. The CEO supplies a clone URL only — owner/name are
// derived server-side from the validated URL (single-sourced identity), and NO token
// or credential is ever accepted (Bureau persists no secrets). testCommand is the
// already-tokenized argv for the `test` worker (e.g. ["npm","test"]).
export const CreateProjectRequestDto = z.object({
  url: z.string().min(1).max(512),
  baseBranch: z.string().max(255).optional(),
  testCommand: z.array(z.string().min(1)).nonempty().optional(),
});

export type CreateProjectRequest = z.infer<typeof CreateProjectRequestDto>;
