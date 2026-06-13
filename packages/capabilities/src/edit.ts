// The `edit` capability — the one implemented worker for the Phase-4 slice.
// It asks a Provider for a set of whole-file edits, then writes them into the
// task's worktree. It is stateless and provider-agnostic (it only sees the
// Provider interface). Computing the git diff is the engine's job, not the
// capability's (capabilities never import @bureau/vcs).

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider, Message } from "@bureau/providers";
import type { Artifact, ArtifactId, StepId } from "@bureau/core";
import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";

export interface FileEdit {
  readonly path: string; // relative to the worktree root
  readonly content: string; // full new file contents
}

export interface EditPlan {
  readonly files: readonly FileEdit[];
  readonly summary: string;
}

export interface EditCapabilityDeps {
  readonly provider: Provider;
  /** Injectable for tests; defaults to writing through node:fs. */
  readonly writeFileFn?: (absPath: string, content: string) => Promise<void>;
  readonly ids?: () => string;
  readonly clock?: () => string;
}

const EDIT_SYSTEM = `You are Bureau's "edit" worker. You are given a change to make to a repository checked out in a worktree.
Respond with ONLY a JSON object — no prose, no markdown fences — of the form:
{"files":[{"path":"relative/path/from/repo/root.ext","content":"<full new file contents>"}],"summary":"one-line description of the change"}
Rules:
- "path" is relative to the repo root and uses forward slashes. Never use absolute paths or "..".
- "content" is the COMPLETE new contents of the file (you are replacing it wholesale, not patching).
- Include every file you change. Keep the change minimal and focused on what was asked.`;

export class EditCapability implements Capability {
  readonly kind = "edit" as const;
  private readonly provider: Provider;
  private readonly write: (absPath: string, content: string) => Promise<void>;
  private readonly ids: () => string;
  private readonly clock: () => string;

  constructor(deps: EditCapabilityDeps) {
    this.provider = deps.provider;
    this.write = deps.writeFileFn ?? defaultWrite;
    this.ids = deps.ids ?? (() => randomUUID());
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async execute(input: CapabilityInput): Promise<CapabilityOutput> {
    const messages: Message[] = [
      { role: "system", content: EDIT_SYSTEM },
      { role: "user", content: buildEditPrompt(input) },
    ];
    const response = await this.provider.send(messages, { maxTokens: 16_000 });
    const plan = parseEditPlan(response.content);

    const artifacts: Artifact[] = [];
    for (const file of plan.files) {
      const absPath = safeResolve(input.worktreePath, file.path);
      await this.write(absPath, file.content);
      artifacts.push({
        id: this.ids() as unknown as ArtifactId,
        kind: "file",
        ref: file.path,
        producedByStep: input.step.id as StepId,
        createdAt: this.clock(),
      });
    }
    return { artifacts, summary: plan.summary };
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

/** Extract and validate the edit plan from a model response (tolerates code fences/prose). */
export function parseEditPlan(raw: string): EditPlan {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`EditCapability: model response was not valid JSON: ${raw.slice(0, 200)}`);
  }
  const obj = parsed as { files?: unknown; summary?: unknown };
  if (!Array.isArray(obj.files)) {
    throw new Error("EditCapability: edit plan is missing a `files` array.");
  }
  const files: FileEdit[] = obj.files.map((f, i) => {
    const file = f as { path?: unknown; content?: unknown };
    if (typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error(`EditCapability: file[${i}] must have string \`path\` and \`content\`.`);
    }
    return { path: file.path, content: file.content };
  });
  return { files, summary: typeof obj.summary === "string" ? obj.summary : "" };
}

function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`EditCapability: no JSON object found in model response: ${raw.slice(0, 200)}`);
  }
  return raw.slice(start, end + 1);
}

/**
 * Resolve a model-proposed relative path against the worktree, REFUSING any path
 * that escapes the worktree (path traversal). The model never gets to write
 * outside the task's isolated worktree.
 */
export function safeResolve(worktreePath: string, relPath: string): string {
  const root = resolve(worktreePath);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`EditCapability: refusing to write outside the worktree: ${relPath}`);
  }
  return target;
}

const defaultWrite = async (absPath: string, content: string): Promise<void> => {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, "utf8");
};
