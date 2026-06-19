// The `plan` capability (Planner) — a READ-ONLY agentic worker that, as the first
// step of a task, inspects the repo and lays out a concrete implementation plan.
// Like `review` it never mutates the worktree (read-only tools, acceptEdits off).
// Its plan is the step's persisted summary, and the engine threads it into the
// later steps' context, so the `edit` worker follows the plan.

import type { Provider } from "@bureau/providers";
import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";
import { runAgenticFileWorker } from "./edit.js";

/** The planner reads, never writes — strictly read-only tools. */
export const PLAN_TOOLS = ["Read", "Glob", "Grep"] as const;

const PLAN_SYSTEM = `You are Bureau's "plan" worker (the Planner). The repository is checked out in your working directory. Inspect the relevant code and produce a SHORT, concrete implementation plan for the goal — the approach and the specific files to change, as a few tight bullet points.

Rules:
- READ ONLY. Do NOT edit any files, do NOT run git. You only plan.
- Be specific and grounded in the actual code you read — name real files/functions; don't invent. Keep it brief (a handful of bullets); no preamble.
- This plan is handed to the worker that will make the change, so make it actionable.`;

export interface PlanCapabilityDeps {
  readonly provider: Provider;
}

export class PlanCapability implements Capability {
  readonly kind = "plan" as const;
  private readonly provider: Provider;

  constructor(deps: PlanCapabilityDeps) {
    this.provider = deps.provider;
  }

  execute(input: CapabilityInput): Promise<CapabilityOutput> {
    return runAgenticFileWorker(this.provider, input, PLAN_SYSTEM, {
      tools: PLAN_TOOLS,
      acceptEdits: false,
      prompt: buildPlanPrompt(input),
      // Keep the WHOLE plan as the summary — it's the deliverable a read-only plan task
      // hands back (and the script later steps follow). A generous cap so a real plan isn't
      // lopped mid-step; it now also lands in full in the Memory journal. The downstream
      // context cost when a plan feeds an edit is ~2k tokens at the cap — negligible.
      summarize: (content) => {
        const plan = content.trim();
        return plan.length > 8000 ? `${plan.slice(0, 7999)}…` : plan || "Planned the change.";
      },
    });
  }
}

export function buildPlanPrompt(input: CapabilityInput): string {
  const criteria = input.step.acceptanceCriteria.map((c) => `- ${c.description}`).join("\n");
  return [
    `Plan how to accomplish this task on the repository.`,
    `Goal: ${input.context}`,
    criteria ? `\nAcceptance criteria:\n${criteria}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
