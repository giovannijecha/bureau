// Shared metadata for the CEO-authorized git operations — one canonical source for
// both the Operations tab (GitOpsPanel) and Iris's inline proposal card
// (GitOpProposalCard). The engine re-validates every op argv-side; this is UI only.

import type { GitOpKind } from "@bureau/contracts";

export type GitOpField = "branch" | "name" | "from" | "to" | "base" | "ref" | "message";

export interface GitOpMeta {
  kind: GitOpKind;
  label: string;
  desc: string;
  fields: GitOpField[];
}

export const GIT_OPS: GitOpMeta[] = [
  { kind: "squash_all", label: "Squash all → one commit + push", desc: "Rewrites the branch's entire history into a single commit and force-pushes it.", fields: ["branch", "message"] },
  { kind: "force_push", label: "Force-push (with lease)", desc: "Force-push the branch to origin — refuses if the remote moved since.", fields: ["branch"] },
  { kind: "reset_hard", label: "Hard reset", desc: "Reset the branch to a ref (e.g. origin/main) — discards local commits.", fields: ["branch", "ref"] },
  { kind: "create_branch", label: "Create branch", desc: "Create a branch on GitHub (off a base ref) — pushed so it's visible there.", fields: ["name", "base"] },
  { kind: "rename_branch", label: "Rename branch", desc: "Rename a branch, on GitHub too.", fields: ["from", "to"] },
  { kind: "delete_branch", label: "Delete branch", desc: "Delete a branch, locally and on GitHub.", fields: ["branch"] },
  { kind: "tag", label: "Create tag", desc: "Create a tag (annotated when a message is given) and push it to GitHub.", fields: ["name", "message"] },
  { kind: "fetch", label: "Fetch + prune", desc: "Fetch and prune from origin.", fields: [] },
];

export const GIT_OP_FIELD_LABELS: Record<GitOpField, string> = {
  branch: "Branch",
  name: "Name",
  from: "From branch",
  to: "To branch",
  base: "Base ref (optional)",
  ref: "Reset to ref",
  message: "Message",
};

/** The fields that should offer a branch-name autocomplete (a known ref, not free text). */
export const BRANCH_FIELDS: ReadonlySet<GitOpField> = new Set(["branch", "from", "base", "ref"]);

export function gitOpMeta(kind: GitOpKind): GitOpMeta {
  return GIT_OPS.find((o) => o.kind === kind) ?? GIT_OPS[0]!;
}
