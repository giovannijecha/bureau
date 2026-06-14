import { z } from "zod";

// System Memory — the org's durable brain, an Obsidian-style markdown vault.
// Two kinds of note: task "journals" auto-written when a task finishes (sourced
// from its decision log + artifacts), and free-form CEO/Iris "notes" (decisions,
// standards, learnings) the CEO writes by hand.

export const NoteKindSchema = z.enum(["journal", "note"]);

export const NoteSummaryDto = z.object({
  /** Vault-relative path, also the note's stable id (e.g. "notes/coding-standards.md"). */
  path: z.string(),
  title: z.string(),
  kind: NoteKindSchema,
  updatedAt: z.string(),
  /** First meaningful line of the body, for the list view. */
  excerpt: z.string(),
});

export const NoteDto = NoteSummaryDto.extend({
  body: z.string(),
});

/** Create or update a free-form CEO/Iris note. */
export const SaveNoteRequestDto = z.object({
  title: z.string().min(1),
  body: z.string(),
});

export type NoteKind = z.infer<typeof NoteKindSchema>;
export type NoteSummary = z.infer<typeof NoteSummaryDto>;
export type Note = z.infer<typeof NoteDto>;
export type SaveNoteRequest = z.infer<typeof SaveNoteRequestDto>;
