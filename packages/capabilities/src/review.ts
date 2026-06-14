// The `review` capability (Reviewer) — a READ-ONLY agentic worker that inspects the
// change produced by earlier steps and flags issues before it reaches the human
// gate. Unlike edit/document it never mutates the worktree: it runs with read-only
// tools and acceptEdits off, so it can only read. Its assessment becomes the step's
// persisted summary (shown to the CEO at the review gate).

import type { Provider } from "@bureau/providers";
import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";
import { runAgenticFileWorker } from "./edit.js";

/** The reviewer reads, never writes — strictly read-only tools. */
export const REVIEW_TOOLS = ["Read", "Glob", "Grep"] as const;

const REVIEW_SYSTEM = `You are Bureau's "review" worker (the Reviewer). An earlier step changed the repository checked out in your working directory. Inspect the change and assess it for the CEO, who will decide whether to merge.

Rules:
- READ ONLY. Do NOT edit any files, do NOT run git, do NOT commit. You only review.
- Be concrete and brief: call out real bugs, security issues, missed requirements, or risky omissions. If it looks correct and complete, say so plainly — don't invent problems.
- End with ONE short verdict line (e.g. "Looks good." or "Risky: <one reason>.").`;

export interface ReviewCapabilityDeps {
  readonly provider: Provider;
}

export class ReviewCapability implements Capability {
  readonly kind = "review" as const;
  private readonly provider: Provider;

  constructor(deps: ReviewCapabilityDeps) {
    this.provider = deps.provider;
  }

  execute(input: CapabilityInput): Promise<CapabilityOutput> {
    return runAgenticFileWorker(this.provider, input, REVIEW_SYSTEM, {
      tools: REVIEW_TOOLS,
      acceptEdits: false,
      prompt: buildReviewPrompt(input),
    });
  }
}

/** The review prompt — the goal plus the diff so far (when the engine supplies it). */
export function buildReviewPrompt(input: CapabilityInput): string {
  const criteria = input.step.acceptanceCriteria.map((c) => `- ${c.description}`).join("\n");
  return [
    `Review the change for this task before it goes to the human for approval.`,
    `Goal: ${input.context}`,
    criteria ? `\nAcceptance criteria:\n${criteria}` : "",
    input.diff
      ? `\nThe change (unified diff):\n${truncateDiff(input.diff)}`
      : `\n(No diff was supplied — inspect the changed files in the working directory yourself.)`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Keep a very large diff from blowing the prompt budget — review the head + note the cut. */
function truncateDiff(diff: string, max = 24_000): string {
  return diff.length <= max ? diff : `${diff.slice(0, max)}\n… (diff truncated; inspect the files directly for the rest)`;
}
