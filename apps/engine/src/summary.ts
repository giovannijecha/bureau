// Map a domain Task to the panel-facing TaskSummary DTO (contracts).

import type { Task, CapabilityKind } from "@bureau/core";
import type { TaskSummary, TaskDetail } from "@bureau/contracts";

/** Each capability maps to a worker persona — who Iris hands that piece to. */
const ASSIGNEE: Record<CapabilityKind, string> = {
  plan: "Planner",
  edit: "Editor",
  test: "Tester",
  review: "Reviewer",
  document: "Scribe",
};

export function toTaskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    repoOwner: task.repoOwner,
    repoName: task.repoName,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    stepCount: task.steps.length,
    completedStepCount: task.steps.filter((s) => s.status === "completed").length,
    pendingGates: task.gates.filter((g) => g.status === "pending" || g.status === "open").length,
  };
}

/** The most recently produced diff for a task, or null if none yet. */
export function latestDiff(task: Task): string | null {
  for (let i = task.artifacts.length - 1; i >= 0; i--) {
    const a = task.artifacts[i]!;
    if (a.kind === "diff") return a.ref;
  }
  return null;
}

/** The opened PR URL for a task, or null if none yet. */
export function prUrl(task: Task): string | null {
  for (let i = task.artifacts.length - 1; i >= 0; i--) {
    const a = task.artifacts[i]!;
    if (a.kind === "pr_url") return a.ref;
  }
  return null;
}

/** Why a task stopped — a failed step's reason or the abort reason. Null unless aborted. */
export function statusNote(task: Task): string | null {
  if (task.status !== "aborted") return null;
  const failed = task.steps.find((s) => s.status === "failed" && s.failureReason);
  if (failed?.failureReason) return failed.failureReason;
  for (let i = task.decisionLog.length - 1; i >= 0; i--) {
    const e = task.decisionLog[i]!;
    if (e.type === "task_aborted") return e.reason;
  }
  return null;
}

export function toTaskDetail(task: Task): TaskDetail {
  return {
    ...toTaskSummary(task),
    diff: latestDiff(task),
    prUrl: prUrl(task),
    statusNote: statusNote(task),
    ...(task.worktreePath !== undefined ? { worktreePath: task.worktreePath } : {}),
    steps: task.steps.map((s) => ({
      id: s.id,
      capability: s.capability,
      assignee: ASSIGNEE[s.capability],
      description: s.description,
      status: s.status,
    })),
    gates: task.gates.map((g) => ({
      id: g.id,
      kind: g.kind,
      status: g.status,
      ...(g.decision !== undefined ? { decision: g.decision } : {}),
    })),
  };
}
