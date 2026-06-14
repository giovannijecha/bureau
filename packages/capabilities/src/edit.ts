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

export class EditCapability implements Capability {
  readonly kind = "edit" as const;
  private readonly provider: Provider;

  constructor(deps: EditCapabilityDeps) {
    this.provider = deps.provider;
  }

  async execute(input: CapabilityInput): Promise<CapabilityOutput> {
    const messages: Message[] = [
      { role: "system", content: EDIT_SYSTEM },
      { role: "user", content: buildEditPrompt(input) },
    ];
    const response = await this.provider.send(messages, {
      maxTokens: 8_000,
      cwd: input.worktreePath,
      tools: [...EDIT_TOOLS],
      acceptEdits: true,
    });
    // The worktree now holds the change; the engine captures the diff. The model's
    // final line is a human-readable summary of what it did.
    return { artifacts: [], summary: summarize(response.content) };
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
