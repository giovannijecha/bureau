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
    prOpen: prOpen(task),
    // Only the UNRESOLVED failure: once the task actually landed (recovery established the
    // base / a retry merged after an earlier failure), the stale merge_error is moot.
    mergeError: unresolvedMergeError(task),
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

/** The task's MOST RECENT terminal land outcome — which of pr_url / base_established /
 *  merge_error was recorded LAST. The land flow can retry (a failed merge then a successful
 *  one, or a failed first attempt then an establish), so the outcome is decided by RECENCY:
 *  a stale earlier merge_error never masks a later success, and vice-versa. */
function lastLand(task: Task): "merged" | "established" | "failed" | null {
  for (let i = task.artifacts.length - 1; i >= 0; i--) {
    const k = task.artifacts[i]!.kind;
    if (k === "pr_url") return "merged";
    if (k === "base_established") return "established";
    if (k === "merge_error") return "failed";
  }
  return null;
}

/** True only when the task genuinely landed on main: completed, and its LATEST land
 *  outcome was a merge (pr_url) or a base-establish (the first task on an empty repo,
 *  whose branch became `main` directly — no PR). A PR merely OPENED for review (pr_open)
 *  does NOT count. Recency-based, so a successful retry after an earlier merge_error reads
 *  as merged (and an unresolved failure never reads as merged). */
export function isMerged(task: Task): boolean {
  if (task.status !== "completed") return false;
  const land = lastLand(task);
  return land === "merged" || land === "established";
}

/** The UNRESOLVED merge failure (the panel's red "didn't land"), or null. Only when the
 *  task's latest land outcome was a failure — a failure later fixed by a retry is moot. */
export function unresolvedMergeError(task: Task): string | null {
  return lastLand(task) === "failed" ? mergeError(task) : null;
}

/** True when the task's branch was pushed and a PR OPENED for review, but NOT merged —
 *  the branch + PR live on GitHub. Deliberately TOLERATES a merge_error (a failed
 *  deferred-merge attempt leaves the PR still open + mergeable), so the CEO keeps the
 *  in-Bureau "Merge to main" retry instead of being stranded; only a real merge (pr_url)
 *  ends the prOpen state. */
export function prOpen(task: Task): boolean {
  return task.status === "completed" && artifactRef(task, "pr_open") !== null && mergedPrUrl(task) === null;
}

/** The most recently produced diff for a task, or null if none yet. */
export function latestDiff(task: Task): string | null {
  return artifactRef(task, "diff");
}

/** The displayable PR URL — whether the PR was merged (pr_url) or just opened (pr_open). */
export function prUrl(task: Task): string | null {
  return mergedPrUrl(task) ?? artifactRef(task, "pr_open");
}

/** Only a MERGED PR's URL (the pr_url artifact) — gates isMerged. */
function mergedPrUrl(task: Task): string | null {
  return artifactRef(task, "pr_url");
}

/** The most recent artifact ref of a given kind, or null. */
function artifactRef(task: Task, kind: Task["artifacts"][number]["kind"]): string | null {
  for (let i = task.artifacts.length - 1; i >= 0; i--) {
    if (task.artifacts[i]!.kind === kind) return task.artifacts[i]!.ref;
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
    // mergeError is already set by toTaskSummary (spread above).
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
      // A task completing is NOT the same as a merge. Only a task that genuinely landed
      // on main reads "Merged to main"; a read-only/no-diff task (research, plan, review)
      // simply "completed", a pushed-but-unmerged one is "PR opened", a confirmed-but-
      // failed merge "didn't land". Never claim a merge that never happened.
      if (isMerged(task)) return { kind: entry.type, label: "Merged to main" };
      if (prOpen(task)) return { kind: entry.type, label: "PR opened for review" };
      if (unresolvedMergeError(task) !== null) return { kind: entry.type, label: "Completed — merge didn't land" };
      return { kind: entry.type, label: "Task completed" };
    case "task_aborted":
      return { kind: entry.type, label: `Aborted — ${entry.reason}` };
    case "task_interrupted":
      return { kind: entry.type, label: "Interrupted by a restart — resume or discard" };
    case "task_resumed":
      return { kind: entry.type, label: "Resumed" };
  }
}

/** The worker persona for the step a log entry refers to. */
function who(task: Task, stepId: StepId): string {
  const step = task.steps.find((s) => s.id === stepId);
  return step ? ASSIGNEE[step.capability] : "A worker";
}
