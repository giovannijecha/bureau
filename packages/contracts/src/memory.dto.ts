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
  /** For a journal: the repo it belongs to ("owner/name"), parsed from its body so the
   *  chat can scope the journal index to the active project WITHOUT re-reading each file.
   *  null/absent for free-form notes (and journals without a Repo line). */
  repo: z.string().nullable().optional(),
});

export const NoteDto = NoteSummaryDto.extend({
  body: z.string(),
});

/** Create or update a free-form CEO/Iris note. `expectedPath` is the path of the
 *  note being edited — saving refuses to overwrite a DIFFERENT existing note (409),
 *  so two distinct titles that slug to the same path never silently clobber. */
export const SaveNoteRequestDto = z.object({
  title: z.string().min(1),
  body: z.string(),
  expectedPath: z.string().optional(),
});

export type NoteKind = z.infer<typeof NoteKindSchema>;
export type NoteSummary = z.infer<typeof NoteSummaryDto>;
export type Note = z.infer<typeof NoteDto>;
export type SaveNoteRequest = z.infer<typeof SaveNoteRequestDto>;

// ── Memory curation (the Archivist) ──────────────────────────────────────────
// A single-call worker proposes a CurationPlan over the whole vault; the CEO reviews and
// approves individual actions; the engine applies them deterministically. Destructive ops
// (compact/prune) ARCHIVE originals (move to archive/) — every run is reversible.

export const CurateOpKindSchema = z.enum(["audit", "compact", "promote", "prune"]);

/** One proposed curation step. `paths` cites the vault entries it concerns. */
export const CurationActionDto = z.object({
  kind: CurateOpKindSchema,
  paths: z.array(z.string()),
  reason: z.string(),
  /** compact: the merged digest journal to write (sources in `paths` are archived). */
  digestTitle: z.string().optional(),
  digestBody: z.string().optional(),
  /** promote: the pinned note to create from a recurring/important decision. */
  noteTitle: z.string().optional(),
  noteBody: z.string().optional(),
});

/** The Archivist's proposal for the whole vault — reviewed before anything is applied. */
export const CurationPlanDto = z.object({
  summary: z.string(),
  actions: z.array(CurationActionDto),
});

/** Ask the engine to produce a fresh curation plan (preview only — mutates nothing). */
export const CurateRequestDto = z.object({
  trigger: z.enum(["manual", "auto"]).optional(),
});

/** Apply the CEO-approved subset of a plan. `accept` is the list of action indices to run. */
export const ApplyCurationRequestDto = z.object({
  plan: CurationPlanDto,
  accept: z.array(z.number().int().nonnegative()),
});

/** Lightweight status for the Memory header: when last curated + how due it is. */
export const CurationStatusDto = z.object({
  lastCuratedAt: z.string().nullable(),
  tasksSinceCuration: z.number().int().nonnegative(),
  vaultNoteCount: z.number().int().nonnegative(),
  /** Auto-nudge threshold (finished tasks between prompts). */
  curateEvery: z.number().int().positive(),
});

export type CurateOpKind = z.infer<typeof CurateOpKindSchema>;
export type CurationAction = z.infer<typeof CurationActionDto>;
export type CurationPlan = z.infer<typeof CurationPlanDto>;
export type CurateRequest = z.infer<typeof CurateRequestDto>;
export type ApplyCurationRequest = z.infer<typeof ApplyCurationRequestDto>;
export type CurationStatus = z.infer<typeof CurationStatusDto>;
