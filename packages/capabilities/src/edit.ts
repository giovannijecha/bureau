// The `edit` capability — the one implemented worker for the Phase-4 slice.
//
// It is AGENTIC: the provider (the `claude` CLI) edits the files in the task's
// worktree DIRECTLY with its tools, confined to that directory (cwd + acceptEdits).
// Bureau captures the resulting diff (the engine's job) — so there's no fragile
// "embed the whole new file in JSON" round-trip that truncates or mis-escapes on
// large or multi-line content. The capability never imports @bureau/vcs.

import { readFile, rm, rename, mkdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname, sep } from "node:path";
import type { Provider, Message } from "@bureau/providers";
import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";

/** The tools the edit worker may use — read + file-edit, NEVER a shell. There is no
 *  edit tool that can delete or rename a file, so the worker requests those via a
 *  `.bureau-ops` manifest that Bureau applies with Node fs (see applyFileOps) — no
 *  shell anywhere, so there's no command-injection surface. Confined to the worktree
 *  by cwd/acceptEdits. */
export const EDIT_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit"] as const;

/** The manifest the worker writes to request file deletes/renames it can't do with edits. */
export const OPS_FILE = ".bureau-ops";

const EDIT_SYSTEM = `You are Bureau's "edit" worker — a senior engineer making a precise change in the repository checked out in your working directory.

Work like a careful engineer who just opened an unfamiliar repo — orient, then match, then change:
1. ORIENT first. Survey the project with Glob (the manifest/config, the directory layout, where similar code lives), then Read the files you'll change AND their neighbours — the modules they import, the helpers/types/patterns already in use, and at least one sibling that does something similar. NEVER edit a file you haven't read.
2. MATCH the codebase. Follow its existing conventions, naming, imports, error handling and style so your change reads as if the same author wrote it. REUSE existing helpers/types/utilities instead of inventing parallel ones.
3. CHANGE with Edit/Write — minimal and focused on exactly what was asked. Don't reformat or touch unrelated files, and don't leave TODOs or stubs: ship complete, working code.

Rules:
- Stay inside the working directory. You have NO shell — do not run commands, and never commit or push; Bureau handles version control. (After you finish, Bureau runs the project's build/tests and feeds any failure back to you for a fix — so write genuinely correct, complete code, but you don't run the checks yourself.)
- You CANNOT delete, move, or rename files with your edit tools. If the task requires deleting/moving/renaming a file, WRITE a file named \`${OPS_FILE}\` in the working-directory root, one operation per line — \`delete <path>\` or \`rename <old> -> <new>\` (paths relative to the working directory) — and Bureau will apply them for you and remove the manifest. Make all OTHER changes by editing files directly with Edit/Write.
- When you are done, reply with ONE short line summarizing what you changed.`;

export interface EditCapabilityDeps {
  readonly provider: Provider;
}

export interface AgenticWorkerOptions {
  /** Tool allowlist (defaults to the edit tools). A read-only worker passes Read/Glob/Grep. */
  readonly tools?: readonly string[];
  /** Auto-accept edits in the worktree (defaults true). A read-only worker passes false. */
  readonly acceptEdits?: boolean;
  /** Override the user prompt (defaults to the edit prompt). */
  readonly prompt?: string;
  /** How to derive the step summary from the model's output (defaults to the last
   *  line). A planner keeps the whole plan so later steps can follow it. */
  readonly summarize?: (content: string) => string;
}

/** Shared body for agentic workers (edit, document, review): the provider works in
 *  the worktree, confined to it. Edit/document mutate it (the engine captures the
 *  diff); review reads it (read-only tools, acceptEdits off). Streams when asked. */
export async function runAgenticFileWorker(
  provider: Provider,
  input: CapabilityInput,
  systemPrompt: string,
  opts: AgenticWorkerOptions = {}
): Promise<CapabilityOutput> {
  // Only works with an agentic provider (one that runs tools in the worktree).
  // Fail loud rather than produce a silent no-op.
  if (provider.agentic !== true) {
    throw new Error(
      `This worker needs an agentic provider (the claude CLI), but "${provider.name}" only does text completion. Install the claude CLI or unset ANTHROPIC_API_KEY.`
    );
  }
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.prompt ?? buildEditPrompt(input) },
  ];
  // INVARIANT: acceptEdits doubles as the "this call MUTATES the worktree" signal — the
  // provider never retries a call with acceptEdits=true (a retried partial edit would
  // double-apply). Any MUTATING worker (edit, document) MUST keep acceptEdits=true;
  // read-only workers (plan/review/research) pass false and are safe to retry.
  const sendOpts = {
    maxTokens: 8_000,
    cwd: input.worktreePath,
    tools: opts.tools ? [...opts.tools] : [...EDIT_TOOLS],
    acceptEdits: opts.acceptEdits ?? true,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  };
  // Stream when the caller wants live progress (the engine pipes chunks to the
  // panel); otherwise a plain send. Both run in the worktree + return usage.
  const response = input.onChunk
    ? await provider.stream(messages, input.onChunk, sendOpts)
    : await provider.send(messages, sendOpts);
  // The worktree now holds the change; the model's final line summarizes it (or a
  // custom summarizer keeps more — a planner keeps the whole plan).
  return {
    artifacts: [],
    summary: (opts.summarize ?? summarize)(response.content),
    usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens, model: response.model ?? provider.name },
  };
}

export class EditCapability implements Capability {
  readonly kind = "edit" as const;
  private readonly provider: Provider;

  constructor(deps: EditCapabilityDeps) {
    this.provider = deps.provider;
  }

  async execute(input: CapabilityInput): Promise<CapabilityOutput> {
    const out = await runAgenticFileWorker(this.provider, input, EDIT_SYSTEM);
    // The worker can't delete/rename with its tools — it requests those in a manifest
    // that Bureau applies with Node fs (no shell, every path confined to the worktree).
    const applied = await applyFileOps(input.worktreePath);
    return applied.length > 0 ? { ...out, summary: `${out.summary} (${applied.join("; ")})` } : out;
  }
}

/** Apply the worker's `.bureau-ops` manifest (delete/rename), then remove it. Pure
 *  Node fs — NO shell, so there is no command-injection surface — and every path is
 *  validated to stay inside the worktree. Returns human descriptions of what it did. */
export async function applyFileOps(worktreePath: string): Promise<string[]> {
  const manifest = join(worktreePath, OPS_FILE);
  let raw: string;
  try {
    raw = await readFile(manifest, "utf8");
  } catch {
    return []; // no manifest — nothing to delete/rename
  }
  const applied: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const del = /^delete\s+(.+)$/i.exec(t);
    const ren = /^rename\s+(.+?)\s*->\s*(.+)$/i.exec(t);
    if (del) {
      const p = within(worktreePath, del[1]!);
      if (p) {
        await rm(p, { recursive: true, force: true }).catch(() => {});
        applied.push(`deleted ${del[1]!.trim()}`);
      }
    } else if (ren) {
      const from = within(worktreePath, ren[1]!);
      const to = within(worktreePath, ren[2]!);
      if (from && to) {
        await mkdir(dirname(to), { recursive: true }).catch(() => {});
        await rename(from, to).catch(() => {});
        applied.push(`renamed ${ren[1]!.trim()} → ${ren[2]!.trim()}`);
      }
    }
  }
  await rm(manifest, { force: true }).catch(() => {}); // never leave the manifest in the diff
  return applied;
}

/** Resolve a manifest-relative path, returning it ONLY if it stays inside the worktree
 *  (rejects absolute paths and `..` traversal). */
function within(worktreePath: string, rel: string): string | null {
  const cleaned = rel.trim().replace(/^["']|["']$/g, "");
  if (cleaned === "" || isAbsolute(cleaned)) return null;
  const abs = resolve(worktreePath, cleaned);
  const r = relative(worktreePath, abs);
  // Reject anything that escapes the worktree (empty = the root itself, ".."-prefixed
  // = traversal, absolute = a different root). `sep` keeps it correct on Windows.
  if (r === "" || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
  return abs;
}

// ---------------------------------------------------------------------------
// Helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export function buildEditPrompt(input: CapabilityInput): string {
  const criteria = input.step.acceptanceCriteria.map((c) => `- ${c.description}`).join("\n");
  return [
    `Change to make: ${input.step.description}`,
    input.context ? `\nContext / goal:\n${input.context}` : "",
    criteria ? `\nAcceptance criteria:\n${criteria}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The model's last non-empty line — a one-line summary of the change. */
export function summarize(content: string): string {
  const line = content
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return "Applied the requested change.";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
