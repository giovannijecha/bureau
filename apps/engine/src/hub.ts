// The Agent-Activity Hub — pure mappers over the live task set. No I/O.
//
// Bureau has no "teams"; its agents are the capability workers. The Hub is a work
// floor over those workers, animated by the steps running across every task, plus
// a company-wide activity feed flattened from every task's decision log.

import type { Task, CapabilityKind, DecisionEntry, StepId } from "@bureau/core";
import type { Activity, WorkerStatus, Hub } from "@bureau/contracts";
import { ASSIGNEE, toTaskSummary, isMerged } from "./summary.js";

/** The full roster of capability kinds, in pipeline order — the worker strip shows
 *  all of them (with `implemented` telling the truth about which are built). */
const CAPABILITY_KINDS: readonly CapabilityKind[] = ["plan", "edit", "test", "review", "document"];

/** Per-capability live status: built? + how many steps of it are running now. */
export function buildWorkerStatus(tasks: readonly Task[], isImplemented: (k: CapabilityKind) => boolean): WorkerStatus[] {
  const running = new Map<CapabilityKind, number>();
  for (const task of tasks) {
    if (task.status !== "executing") continue;
    for (const step of task.steps) {
      if (step.status === "running") running.set(step.capability, (running.get(step.capability) ?? 0) + 1);
    }
  }
  return CAPABILITY_KINDS.map((capability) => {
    const runningStepCount = running.get(capability) ?? 0;
    return {
      capability,
      assignee: ASSIGNEE[capability],
      implemented: isImplemented(capability),
      live: runningStepCount > 0,
      runningStepCount,
    };
  });
}

/** Flatten every task's decision log into a single, newest-first activity feed. */
export function buildActivity(tasks: readonly Task[], limit: number): Activity[] {
  const all: Activity[] = [];
  for (const task of tasks) {
    task.decisionLog.forEach((entry, i) => {
      const { kind, label } = describe(task, entry);
      all.push({ id: `${task.id}:${i}`, kind, taskId: task.id, taskGoal: task.goal, at: entry.at, label });
    });
  }
  // Newest first; ISO-8601 timestamps sort lexicographically.
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return all.slice(0, limit);
}

/** Everything the Hub renders, in one bundle. */
export function buildHub(tasks: readonly Task[], isImplemented: (k: CapabilityKind) => boolean, activityLimit = 40): Hub {
  const awaitingReview = tasks.filter((t) => t.gates.some((g) => g.status === "open"));
  return {
    workers: buildWorkerStatus(tasks, isImplemented),
    activity: buildActivity(tasks, activityLimit),
    awaitingReview: awaitingReview.map(toTaskSummary),
    stats: {
      activeTasks: tasks.filter((t) => t.status === "planning" || t.status === "executing").length,
      awaitingReview: awaitingReview.length,
      merged: tasks.filter(isMerged).length,
    },
  };
}

// ── labels ───────────────────────────────────────────────────────────────────

function describe(task: Task, entry: DecisionEntry): { kind: string; label: string } {
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

/** The worker persona for the step an entry refers to. */
function who(task: Task, stepId: StepId): string {
  const step = task.steps.find((s) => s.id === stepId);
  return step ? ASSIGNEE[step.capability] : "A worker";
}
