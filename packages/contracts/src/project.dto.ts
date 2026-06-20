import { z } from "zod";

// A project is one GitHub repository Bureau works on. The CEO picks the active
// project in the Assistant so Iris knows where we're working. Server-internal
// details (clone url, on-disk paths) are NOT exposed — only what the panel needs.

export const ProjectDto = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  baseBranch: z.string(),
  /** The configured test command (already-tokenized argv) — powers the advisory `test` worker,
   *  and is the verify-loop fallback when `verifyCommands` is unset. Absent ⇒ none configured. */
  testCommand: z.array(z.string()).optional(),
  /** The post-edit verify loop's full check list — a list of argv commands (build, typecheck,
   *  test) run in order. When set it OVERRIDES `testCommand` for verification. Absent ⇒ fall
   *  back to the single `testCommand`. */
  verifyCommands: z.array(z.array(z.string())).optional(),
  /** CEO override for the dependency-install command (argv). Absent ⇒ Bureau auto-detects the stack. */
  provisionCommand: z.array(z.string()).optional(),
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

// Patch an existing project's command config from the panel — the only way to turn the verify
// loop on for a repo added by URL (the add form takes a URL only). A PARTIAL update: each field
// is independently optional — a field that is PRESENT is applied (a non-empty argv sets it,
// `null` clears it); a field that is ABSENT is left untouched. All argv are already-tokenized
// (the client splits; the server never parses a string into a command).
export const SetProjectCommandRequestDto = z
  .object({
    /** Single argv for the `test` worker / verify fallback. */
    testCommand: z.array(z.string().min(1)).nonempty().nullable().optional(),
    /** The verify loop's full check list — each entry a non-empty argv. */
    verifyCommands: z.array(z.array(z.string().min(1)).nonempty()).nonempty().nullable().optional(),
    /** Dependency-install override (argv). */
    provisionCommand: z.array(z.string().min(1)).nonempty().nullable().optional(),
  })
  // Reject an empty patch ({}) so a no-op PATCH is a clear 400, not a silent success.
  .refine((b) => b.testCommand !== undefined || b.verifyCommands !== undefined || b.provisionCommand !== undefined, {
    message: "Provide at least one of testCommand, verifyCommands, or provisionCommand.",
  });

export type SetProjectCommandRequest = z.infer<typeof SetProjectCommandRequestDto>;
