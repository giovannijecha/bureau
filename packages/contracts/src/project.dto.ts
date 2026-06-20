import { z } from "zod";

// A project is one GitHub repository Bureau works on. The CEO picks the active
// project in the Assistant so Iris knows where we're working. Server-internal
// details (clone url, on-disk paths) are NOT exposed — only what the panel needs.

export const ProjectDto = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  baseBranch: z.string(),
  /** The configured test/verify command (already-tokenized argv) — powers both the advisory
   *  `test` worker and the post-edit verify loop. Absent ⇒ none configured. */
  testCommand: z.array(z.string()).optional(),
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

// Set (or clear) an existing project's test/verify command from the panel — the only way to
// turn the verify loop on for a repo added by URL (the add form takes a URL only). A non-empty
// argv array sets it; null clears it. Already-tokenized (the client splits; the server never
// parses a string into a command).
export const SetProjectCommandRequestDto = z.object({
  testCommand: z.array(z.string().min(1)).nonempty().nullable(),
});

export type SetProjectCommandRequest = z.infer<typeof SetProjectCommandRequestDto>;
