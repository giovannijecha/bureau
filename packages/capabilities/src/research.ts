// The `research` capability (Researcher) — a READ-ONLY agentic worker that investigates
// the codebase AND, when useful, the web/official docs, producing a grounded findings
// brief that the planner and editor consume. Like `plan`/`review` it never mutates the
// worktree (read-only tools, acceptEdits off); unlike them it may also reach the web.

import type { Provider } from "@bureau/providers";
import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";
import { runAgenticFileWorker } from "./edit.js";

/** Read-only codebase inspection + web research — never writes. */
export const RESEARCH_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"] as const;

const RESEARCH_SYSTEM = `You are Bureau's "research" worker (the Researcher). The repository is checked out in your working directory. Investigate what's asked — across the codebase (read the relevant files) AND, when useful, the web/official docs — and produce a SHORT, grounded findings brief.

Rules:
- READ ONLY. Do NOT edit any files, do NOT run git. You only investigate and report.
- Ground every finding in something you actually read — cite real file paths (and URLs for web sources). NEVER invent files, APIs, or facts; if you couldn't verify something, say so plainly.
- Be concise and actionable: the planner/editor will build on this. A handful of tight bullets — the key findings, the relevant files, and any external gotchas — no preamble.`;

export interface ResearchCapabilityDeps {
  readonly provider: Provider;
}

export class ResearchCapability implements Capability {
  readonly kind = "research" as const;
  private readonly provider: Provider;

  constructor(deps: ResearchCapabilityDeps) {
    this.provider = deps.provider;
  }

  execute(input: CapabilityInput): Promise<CapabilityOutput> {
    return runAgenticFileWorker(this.provider, input, RESEARCH_SYSTEM, {
      tools: RESEARCH_TOOLS,
      acceptEdits: false,
      prompt: buildResearchPrompt(input),
      // Keep the WHOLE findings brief — it IS the deliverable (a read-only research task
      // produces no files), so it must survive intact to the task card + the Memory journal.
      // A generous cap (a grounded brief with citations easily exceeds the old 1500); the
      // extra downstream context when research feeds a plan/edit is ~2k tokens at the cap —
      // negligible against an Opus context window.
      summarize: (content) => {
        const brief = content.trim();
        return brief.length > 8000 ? `${brief.slice(0, 7999)}…` : brief || "Investigated; no notable findings.";
      },
    });
  }
}

export function buildResearchPrompt(input: CapabilityInput): string {
  const criteria = input.step.acceptanceCriteria.map((c) => `- ${c.description}`).join("\n");
  return [
    `Investigate the following for this repository and report grounded findings.`,
    `Topic: ${input.step.description}`,
    input.context ? `\nContext / goal:\n${input.context}` : "",
    criteria ? `\nWhat to find out:\n${criteria}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
