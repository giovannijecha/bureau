// Canonical capability-worker presentation (icon + persona blurb), shared by the Agents
// roster, the Hub floor, and anywhere a worker is shown — so the icon for, say, the
// Researcher is identical everywhere instead of drifting per page.

import { Compass, Telescope, Pencil, FlaskConical, Eye, FileText, type LucideIcon } from "lucide-react";

export interface WorkerMeta {
  icon: LucideIcon;
  /** Display name (matches the engine's assignee). */
  label: string;
  desc: string;
}

export const WORKER: Record<string, WorkerMeta> = {
  plan: { icon: Compass, label: "Planner", desc: "Breaks a request into ordered steps and acceptance criteria." },
  research: { icon: Telescope, label: "Researcher", desc: "Investigates the codebase and the web/docs, returning a grounded findings brief." },
  edit: { icon: Pencil, label: "Editor", desc: "Applies the change in an isolated git worktree, then surfaces the diff." },
  test: { icon: FlaskConical, label: "Tester", desc: "Runs the repository's test suite against the change." },
  review: { icon: Eye, label: "Reviewer", desc: "Inspects the diff and flags issues before it reaches you." },
  document: { icon: FileText, label: "Scribe", desc: "Updates docs, the README, or a changelog for the change." },
};

export function workerMeta(capability: string): WorkerMeta {
  return WORKER[capability] ?? { icon: Pencil, label: capability, desc: "" };
}
