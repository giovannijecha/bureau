import { describe, it, expect } from "vitest";
import type { Task, Artifact, ArtifactKind, ArtifactId, StepId, TaskId, DecisionEntry } from "@bureau/core";
import { toTaskSummary, toTaskDetail } from "../src/summary.js";

// Regression guard: a task COMPLETING is not the same as a MERGE. A read-only task
// (research/plan/review) finishes without ever touching main — the timeline must say
// "Task completed", and the summary must NOT flag it as a failed merge. Only a task that
// genuinely landed on main reads "Merged to main". (Surfaced by a research task that the
// panel falsely showed as "Merged to main" + "merge failed".)

const AT = "2026-06-19T08:54:00.000Z";

function artifact(kind: ArtifactKind, ref: string): Artifact {
  return { id: `a-${kind}` as ArtifactId, kind, ref, producedByStep: "step-1" as StepId, createdAt: AT };
}

function completedTask(artifacts: Artifact[]): Task {
  const completed: DecisionEntry = { type: "task_completed", at: AT };
  return {
    id: "task-1" as TaskId,
    goal: "Research: stack TUI di OpenCode",
    repoOwner: "acme",
    repoName: "widget",
    status: "completed",
    steps: [],
    gates: [],
    artifacts,
    decisionLog: [{ type: "task_created", at: AT, goal: "g" }, completed],
    createdAt: AT,
    updatedAt: AT,
  };
}

/** The label the panel renders for the task's terminal timeline event. */
function completionLabel(task: Task): string {
  const e = toTaskDetail(task).timeline.find((t) => t.type === "task_completed");
  return e?.label ?? "(none)";
}

describe("toTimeline — task_completed label reflects what actually happened", () => {
  it("a read-only/no-diff completion reads 'Task completed', never 'Merged to main'", () => {
    expect(completionLabel(completedTask([]))).toBe("Task completed");
  });

  it("a genuinely merged task reads 'Merged to main'", () => {
    const t = completedTask([artifact("pr_url", "https://github.com/acme/widget/pull/1")]);
    expect(completionLabel(t)).toBe("Merged to main");
  });

  it("a pushed-but-unmerged task reads 'PR opened for review'", () => {
    const t = completedTask([artifact("pr_open", "https://github.com/acme/widget/pull/2")]);
    expect(completionLabel(t)).toBe("PR opened for review");
  });

  it("a confirmed merge that errored reads 'Completed — merge didn't land'", () => {
    const t = completedTask([artifact("merge_error", "merge conflict in README.md")]);
    expect(completionLabel(t)).toBe("Completed — merge didn't land");
  });

  it("a failed DEFERRED merge (pr_open + merge_error) keeps reading 'PR opened for review'", () => {
    // mergeOpenPr records ONLY merge_error and leaves pr_open intact, so the CEO keeps
    // the in-Bureau retry. prOpen() tolerates the error → never a false "merge didn't land".
    const t = completedTask([
      artifact("pr_open", "https://github.com/acme/widget/pull/4"),
      artifact("merge_error", "branch protection"),
    ]);
    expect(completionLabel(t)).toBe("PR opened for review");
  });

  it("a failed DIRECT merge (pr_url + merge_error) reads 'Completed — merge didn't land', NOT merged", () => {
    // A direct confirm-merge that fails records BOTH pr_url and merge_error. The
    // mergeError-guard in isMerged() is the only thing keeping this from reading "merged".
    const t = completedTask([
      artifact("pr_url", "https://github.com/acme/widget/pull/5"),
      artifact("merge_error", "merge conflict in README.md"),
    ]);
    expect(completionLabel(t)).toBe("Completed — merge didn't land");
  });
});

describe("toTaskSummary — mergeError distinguishes a failed merge from a clean completion", () => {
  it("is null for a read-only task that simply completed (so the Git page can't say 'merge failed')", () => {
    const s = toTaskSummary(completedTask([]));
    expect(s.mergeError).toBeNull();
    expect(s.merged).toBe(false);
    expect(s.prOpen).toBe(false);
  });

  it("carries the reason when a merge genuinely failed", () => {
    const s = toTaskSummary(completedTask([artifact("merge_error", "branch protection")]));
    expect(s.mergeError).toBe("branch protection");
    expect(s.merged).toBe(false);
  });

  it("is null on a merged task (no error)", () => {
    const s = toTaskSummary(completedTask([artifact("pr_url", "https://github.com/acme/widget/pull/3")]));
    expect(s.merged).toBe(true);
    expect(s.mergeError).toBeNull();
  });

  it("a failed direct merge (pr_url + merge_error) is mergeError-set and NOT merged (the guard holds)", () => {
    const s = toTaskSummary(
      completedTask([artifact("pr_url", "https://github.com/acme/widget/pull/5"), artifact("merge_error", "conflict")])
    );
    expect(s.merged).toBe(false);
    expect(s.mergeError).toBe("conflict");
  });
});
