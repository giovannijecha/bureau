// System Memory helpers — pure mappers between Tasks/notes and the vault.
//
// A task journal is auto-written when a task ends: a markdown note distilled from
// the task's decision log + artifacts (goal, the pipeline that ran, the outcome).
// CEO/Iris notes are free-form. The note's "kind" is its folder: journals/ vs notes/.

import type { Task } from "@bureau/core";
import type { NoteSummary, NoteKind } from "@bureau/contracts";
import { ASSIGNEE, latestDiff, prUrl, mergeError, isMerged, statusNote } from "./summary.js";

export const JOURNAL_DIR = "journals";
export const NOTE_DIR = "notes";

/** A filesystem-safe slug from arbitrary text. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "note";
}

/** The deterministic vault path for a task's journal — re-journaling overwrites it. */
export function journalPath(task: Task): string {
  const date = task.createdAt.slice(0, 10); // YYYY-MM-DD
  return `${JOURNAL_DIR}/${date}-${slug(task.goal)}-${task.id.slice(0, 8)}.md`;
}

/** The vault path for a free-form CEO note titled `title`. */
export function notePath(title: string): string {
  return `${NOTE_DIR}/${slug(title)}.md`;
}

/** The kind of a note, from its folder. */
export function noteKind(path: string): NoteKind {
  return path.startsWith(`${JOURNAL_DIR}/`) ? "journal" : "note";
}

/** Build a NoteSummary from a note's path, content, and modified time. For a journal,
 *  parse its repo here (once, from the body we already have) so the chat can scope the
 *  journal index per-project from list() alone — no second read per candidate. */
export function noteSummary(path: string, content: string, updatedAt: string): NoteSummary {
  const kind = noteKind(path);
  return {
    path,
    title: titleOf(path, content),
    kind,
    updatedAt,
    excerpt: excerptOf(content),
    ...(kind === "journal" ? { repo: journalRepo(content) } : {}),
  };
}

/** Close a dangling code fence in embedded worker text. A brief truncated mid-fence (or a
 *  worker that emits an unmatched ```) would otherwise run to end-of-document in the Memory
 *  viewer, swallowing the rest of the journal (Pipeline, Changed files) into one code block.
 *  Appending a closing fence keeps the journal's own sections intact. */
function balanceFences(text: string): string {
  const fences = (text.match(/^```/gm) ?? []).length;
  return fences % 2 === 0 ? text : `${text}\n\`\`\``;
}

/** The repo a journal belongs to ("owner/name"), parsed from its body, or null. Lets the
 *  chat scope the journal index to the active project — the vault is shared across repos. */
export function journalRepo(body: string): string | null {
  const m = /^- \*\*Repo:\*\* (.+)$/m.exec(body);
  return m ? m[1]!.trim() : null;
}

/** The journal markdown for a finished task — distilled from its state. */
export function journalMarkdown(task: Task, at: string): string {
  const outcome = isMerged(task)
    ? `Merged to main${prUrl(task) ? ` — ${prUrl(task)}` : ""}.`
    : mergeError(task)
      ? `Merge did not land: ${mergeError(task)}${prUrl(task) ? ` (PR: ${prUrl(task)})` : ""}.`
      : task.status === "aborted"
        ? `Stopped before finishing${statusNote(task) ? `: ${statusNote(task)}` : "."}`
        : `Status: ${task.status}.`;

  const pipeline = task.steps
    .map((s, i) => `${i + 1}. **${ASSIGNEE[s.capability]}** (${s.capability}) — ${s.description} — _${s.status.replace(/_/g, " ")}_`)
    .join("\n");

  // Each worker's actual report — the deliverable of a read-only task (research findings,
  // a plan, a review). Without this the journal recorded only metadata, so a research
  // task's findings lived nowhere durable: not on GitHub (read-only, no commit) and not
  // in System Memory. Now they land here, in full, browsable in the Memory tab + Obsidian.
  const reports = task.steps
    .filter((s) => (s.summary ?? "").trim() !== "")
    .map((s) => `### ${ASSIGNEE[s.capability]} — ${s.capability}\n\n${balanceFences(s.summary!.trim())}`)
    .join("\n\n");

  const changed = changedFiles(latestDiff(task));
  const changes = changed.length > 0 ? changed.map((f) => `- \`${f}\``).join("\n") : "_No file changes captured._";

  return [
    `# ${task.goal}`,
    "",
    `- **Status:** ${task.status}`,
    `- **Repo:** ${task.repoOwner}/${task.repoName}`,
    `- **Task:** ${task.id}`,
    `- **Recorded:** ${at}`,
    "",
    "## Outcome",
    "",
    outcome,
    "",
    "## Reports",
    "",
    reports || "_No worker reports captured._",
    "",
    "## Pipeline",
    "",
    pipeline || "_No steps._",
    "",
    "## Changed files",
    "",
    changes,
    "",
    "---",
    "_Auto-written by Bureau from the task's decision log._",
    "",
  ].join("\n");
}

// ── parsing ────────────────────────────────────────────────────────────────

function titleOf(path: string, content: string): string {
  const h1 = content.split("\n").find((l) => l.startsWith("# "));
  if (h1) return h1.slice(2).trim();
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

function excerptOf(content: string): string {
  for (const raw of content.split("\n")) {
    const l = raw.trim();
    if (l === "" || l.startsWith("#") || l.startsWith("- **") || l === "---") continue;
    return l.length > 140 ? `${l.slice(0, 139)}…` : l;
  }
  return "";
}

/** Changed file paths parsed from a unified diff. */
function changedFiles(diff: string | null): string[] {
  if (!diff) return [];
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice("diff --git ".length);
      const idx = rest.lastIndexOf(" b/");
      files.push(idx >= 0 ? rest.slice(idx + 3) : rest);
    }
  }
  return files;
}
