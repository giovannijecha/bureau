// The `edit` capability — the one implemented worker for the Phase-4 slice.
//
// It is AGENTIC: the provider (the `claude` CLI) edits the files in the task's
// worktree DIRECTLY with its tools, confined to that directory (cwd + acceptEdits).
// Bureau captures the resulting diff (the engine's job) — so there's no fragile
// "embed the whole new file in JSON" round-trip that truncates or mis-escapes on
// large or multi-line content. The capability never imports @bureau/vcs.

import type { Provider, Message } from "@bureau/providers";
import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";

/** The tools the edit worker may use — read + file-edit, never Bash or anything
 *  that could run arbitrary commands. Confined to the worktree by cwd/acceptEdits. */
export const EDIT_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "MultiEdit"] as const;

const EDIT_SYSTEM = `You are Bureau's "edit" worker. The repository is checked out in your working directory. Make the requested change by editing the files DIRECTLY with your tools — Read to inspect current contents, Edit/Write to change them.

Rules:
- Stay inside the working directory. Do NOT run git, do NOT commit or push — Bureau handles version control.
- Keep the change minimal and focused on exactly what was asked; don't reformat or touch unrelated files.
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
  const sendOpts = {
    maxTokens: 8_000,
    cwd: input.worktreePath,
    tools: opts.tools ? [...opts.tools] : [...EDIT_TOOLS],
    acceptEdits: opts.acceptEdits ?? true,
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

  execute(input: CapabilityInput): Promise<CapabilityOutput> {
    return runAgenticFileWorker(this.provider, input, EDIT_SYSTEM);
  }
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
