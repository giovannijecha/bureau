// Map a domain Task to the panel-facing TaskSummary DTO (contracts).

import type { Task, CapabilityKind, DecisionEntry, StepId } from "@bureau/core";
import type { TaskSummary, TaskDetail, TimelineEntry } from "@bureau/contracts";

/** Each capability maps to a worker persona — who Iris hands that piece to. */
export const ASSIGNEE: Record<CapabilityKind, string> = {
  plan: "Planner",
  research: "Researcher",
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
    // A step parked at its gate (blocked_on_gate) has finished its WORK — count it as
    // done so a reviewed/merged task reads 1/1, not 0/1 (also covers older DB rows).
    completedStepCount: task.steps.filter((s) => s.status === "completed" || s.status === "blocked_on_gate").length,
    pendingGates: task.gates.filter((g) => g.status === "pending" || g.status === "open").length,
    merged: isMerged(task),
  };
}

/** The merge-failure reason (conflicts, branch protection, …), or null. Set when
 *  the CEO confirmed the merge but it couldn't land — so the panel never claims a
 *  task "merged" when it didn't. */
export function mergeError(task: Task): string | null {
  for (let i = task.artifacts.length - 1; i >= 0; i--) {
    const a = task.artifacts[i]!;
    if (a.kind === "merge_error") return a.ref;
  }
  return null;
}

/** True only when the task genuinely landed on main: completed, has a PR URL, and
 *  no recorded merge error. Distinguishes a real merge from a confirmed-but-failed one. */
export function isMerged(task: Task): boolean {
  return task.status === "completed" && prUrl(task) !== null && mergeError(task) === null;
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
    mergeError: mergeError(task),
    steps: task.steps.map((s) => ({
      id: s.id,
      capability: s.capability,
      assignee: ASSIGNEE[s.capability],
      description: s.description,
      // A completed task's gated step is done — show it completed, not blocked_on_gate.
      status: task.status === "completed" && s.status === "blocked_on_gate" ? "completed" : s.status,
      failureReason: s.failureReason ?? null,
      summary: s.summary ?? null,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
    })),
    gates: task.gates.map((g) => ({
      id: g.id,
      kind: g.kind,
      status: g.status,
      ...(g.decision !== undefined ? { decision: g.decision } : {}),
    })),
    timeline: toTimeline(task),
  };
}

/** Flatten a task's append-only decision log into a timeline (oldest first) — the
 *  full history the panel renders: substeps, gates, and request-changes cycles. */
export function toTimeline(task: Task): TimelineEntry[] {
  return task.decisionLog.map((entry) => {
    const { kind, label } = describe(task, entry);
    return { type: kind, at: entry.at, label };
  });
}

/** A one-line, human label + a kind (for the icon) for one decision-log entry.
 *  Shared by the Hub activity feed and the task timeline. */
export function describe(task: Task, entry: DecisionEntry): { kind: string; label: string } {
  switch (entry.type) {
    case "task_created":
      return { kind: entry.type, label: "Task created" };
    case "step_started":
      return { kind: entry.type, label: `${who(task, entry.stepId)} started` };
    case "step_completed":
      return { kind: entry.type, label: `${who(task, entry.stepId)} finished` };
    case "step_failed":
      return { kind: entry.type, label: `${who(task, entry.stepId)} failed — ${entry.reason}` };
    case "gate_opened":
      return { kind: entry.type, label: "Ready for your review" };
    case "gate_reopened":
      return { kind: entry.type, label: "Revising — changes requested" };
    case "gate_decided":
      return { kind: entry.type, label: `Review ${entry.decision}` };
    case "task_completed":
      return { kind: entry.type, label: "Merged to main" };
    case "task_aborted":
      return { kind: entry.type, label: `Aborted — ${entry.reason}` };
  }
}

/** The worker persona for the step a log entry refers to. */
function who(task: Task, stepId: StepId): string {
  const step = task.steps.find((s) => s.id === stepId);
  return step ? ASSIGNEE[step.capability] : "A worker";
}
