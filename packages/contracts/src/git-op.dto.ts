import { z } from "zod";

// CEO-authorized git history/admin operations. The panel sends one of these; the
// engine validates the type-to-confirm gate (destructive ops) and runs it argv-only.
export const GitOpKindSchema = z.enum([
  "squash_all",
  "force_push",
  "reset_hard",
  "create_branch",
  "rename_branch",
  "delete_branch",
  "tag",
  "fetch",
]);

// A ref/name token — bounded + no angle brackets (XSS defense-in-depth). The vcs layer
// re-validates strictly with assertSafeRef (alphanumeric start, no leading "-", no "..")
// before anything reaches git, so this only needs to bound the length + block markup.
const refStr = z.string().min(1).max(200).regex(/^[^<>]*$/);

export const GitOpRequestDto = z.object({
  projectId: z.string().optional(),
  kind: GitOpKindSchema,
  branch: refStr.optional(),
  name: refStr.optional(),
  from: refStr.optional(),
  to: refStr.optional(),
  base: refStr.optional(),
  ref: refStr.optional(),
  /** Commit/tag message (content, not a ref). */
  message: z.string().max(500).optional(),
  /** Destructive ops: the CEO must type the target branch name here to confirm. */
  confirmation: z.string().max(200).optional(),
});

export const GitOpResultDto = z.object({ ok: z.boolean(), message: z.string() });

export type GitOpKind = z.infer<typeof GitOpKindSchema>;
export type GitOpRequest = z.infer<typeof GitOpRequestDto>;
export type GitOpResult = z.infer<typeof GitOpResultDto>;

/** Operations that rewrite/destroy history or publish to GitHub — they require the CEO
 *  to type the target branch name to confirm (validated server-side, exact match). */
export const DESTRUCTIVE_GIT_OPS: ReadonlySet<GitOpKind> = new Set([
  "squash_all",
  "force_push",
  "reset_hard",
  "delete_branch",
]);
