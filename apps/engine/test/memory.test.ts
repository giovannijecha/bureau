import { describe, it, expect } from "vitest";
import type { Task, Step, StepId, TaskId, DecisionEntry } from "@bureau/core";
import { journalMarkdown } from "../src/memory.js";

// A read-only task (research/plan/review) produces NO files — its worker's report IS the
// deliverable. The journal must carry that report in full, so a research task's findings
// are retrievable in System Memory (they live nowhere else: no commit, no PR, no branch).

const AT = "2026-06-19T09:30:00.000Z";

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: "step-1" as StepId,
    capability: "research",
    description: "Investigate the OpenCode TUI stack",
    acceptanceCriteria: [],
    status: "completed",
    artifactIds: [],
    ...overrides,
  };
}

function task(steps: Step[]): Task {
  const completed: DecisionEntry = { type: "task_completed", at: AT };
  return {
    id: "task-1" as TaskId,
    goal: "Research stack OpenCode",
    repoOwner: "giovannijecha",
    repoName: "dante",
    status: "completed",
    steps,
    gates: [],
    artifacts: [],
    decisionLog: [{ type: "task_created", at: AT, goal: "g" }, completed],
    createdAt: AT,
    updatedAt: AT,
  };
}

describe("journalMarkdown — worker reports land in the journal (System Memory)", () => {
  it("includes a ## Reports section with the worker's full findings", () => {
    const findings = "## Findings\n\nThe TUI renderer is OpenTUI driving SolidJS. State uses Effect.";
    const md = journalMarkdown(task([step({ summary: findings })]), AT);

    expect(md).toContain("## Reports");
    expect(md).toContain("### Researcher — research");
    expect(md).toContain("The TUI renderer is OpenTUI driving SolidJS.");
  });

  it("lists each step's report under its persona", () => {
    const steps = [
      step({ id: "s1" as StepId, capability: "plan", description: "Plan it", summary: "PLAN: do A then B." }),
      step({ id: "s2" as StepId, capability: "research", description: "Research it", summary: "Found library X." }),
    ];
    const md = journalMarkdown(task(steps), AT);
    expect(md).toContain("### Planner — plan");
    expect(md).toContain("PLAN: do A then B.");
    expect(md).toContain("### Researcher — research");
    expect(md).toContain("Found library X.");
  });

  it("falls back gracefully when a step has no report", () => {
    const md = journalMarkdown(task([step({ summary: undefined })]), AT);
    expect(md).toContain("## Reports");
    expect(md).toContain("_No worker reports captured._");
  });

  it("balances a dangling code fence so it can't swallow the rest of the journal", () => {
    // A brief truncated mid-fence leaves an unclosed ``` — without balancing it would run
    // to EOF in the Memory viewer and hide ## Pipeline / ## Changed files.
    const truncated = "Here is the config:\n```ts\nexport const x = 1;"; // no closing fence
    const md = journalMarkdown(task([step({ summary: truncated })]), AT);

    const fenceCount = (md.match(/^```/gm) ?? []).length;
    expect(fenceCount % 2).toBe(0); // balanced
    // The sections AFTER the report are still real headings, not trapped in a code block.
    expect(md).toContain("## Pipeline");
    expect(md).toContain("## Changed files");
  });
});
