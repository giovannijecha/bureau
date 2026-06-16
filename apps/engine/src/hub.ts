// The Agent-Activity Hub — pure mappers over the live task set. No I/O.
//
// Bureau has no "teams"; its agents are the capability workers. The Hub is a work
// floor over those workers, animated by the steps running across every task, plus
// a company-wide activity feed flattened from every task's decision log.

import type { Task, CapabilityKind } from "@bureau/core";
import type { Activity, WorkerStatus, Hub } from "@bureau/contracts";
import { ASSIGNEE, toTaskSummary, isMerged, describe } from "./summary.js";

/** The full roster of capability kinds, in pipeline order — the worker strip shows
 *  all of them (with `implemented` telling the truth about which are built). */
const CAPABILITY_KINDS: readonly CapabilityKind[] = ["plan", "research", "edit", "test", "review", "document"];

/** Per-capability live status: built? + how many steps are running now + lifetime total. */
export function buildWorkerStatus(tasks: readonly Task[], isImplemented: (k: CapabilityKind) => boolean): WorkerStatus[] {
  const running = new Map<CapabilityKind, number>();
  const done = new Map<CapabilityKind, number>();
  for (const task of tasks) {
    for (const step of task.steps) {
      if (step.status === "completed") done.set(step.capability, (done.get(step.capability) ?? 0) + 1);
      if (task.status === "executing" && step.status === "running") running.set(step.capability, (running.get(step.capability) ?? 0) + 1);
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
      totalStepCount: done.get(capability) ?? 0,
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

// (label/`describe` live in summary.ts — shared with the task timeline.)

/** Everything the Hub renders, in one bundle. */
export function buildHub(tasks: readonly Task[], isImplemented: (k: CapabilityKind) => boolean, activityLimit = 40): Hub {
  // Genuinely waiting on the human: status is awaiting_human AND a gate is open.
  // (A task aborted mid-gate keeps an open gate in its log, but its status is
  // 'aborted' — it must never appear in the review queue.)
  const awaitingReview = tasks.filter((t) => t.status === "awaiting_human" && t.gates.some((g) => g.status === "open"));
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

