"use client";

// A "what each task did" feed: events grouped BY TASK (goal shown once) with a compact
// journey of the recent steps/gates beneath — instead of a long, flat, repetitive list
// that echoes the same goal on every micro-event row. Shared by the Hub and Metrics.

import Link from "next/link";
import {
  GitMerge,
  CheckCircle2,
  CircleDot,
  XCircle,
  Play,
  ListTodo,
  Plus,
  Pencil,
  Check,
  Activity as ActivityIcon,
  type LucideIcon,
} from "lucide-react";
import type { Activity, TaskSummary } from "@bureau/contracts";
import { cn } from "../lib/utils";

const KIND: Record<string, { icon: LucideIcon; tint: string }> = {
  task_created: { icon: Plus, tint: "text-muted-foreground" },
  step_started: { icon: Play, tint: "text-blue-400" },
  step_completed: { icon: CheckCircle2, tint: "text-green-500" },
  step_failed: { icon: XCircle, tint: "text-red-500" },
  gate_opened: { icon: CircleDot, tint: "text-amber-500" },
  gate_reopened: { icon: Pencil, tint: "text-amber-500" },
  gate_decided: { icon: Check, tint: "text-green-500" },
  // A completion isn't necessarily a merge — use a neutral "done" check, not a merge glyph.
  task_completed: { icon: CheckCircle2, tint: "text-green-500" },
  task_aborted: { icon: XCircle, tint: "text-red-500" },
};

type Badge = { text: string; cls: string; icon: LucideIcon; tint: string };
const BADGE = {
  merged: { text: "merged", cls: "border-green-500/40 text-green-500", icon: GitMerge, tint: "text-green-500" },
  completed: { text: "completed", cls: "border-green-500/40 text-green-500", icon: CheckCircle2, tint: "text-green-500" },
  awaiting: { text: "awaiting review", cls: "border-amber-500/40 text-amber-500", icon: CircleDot, tint: "text-amber-500" },
  stopped: { text: "stopped", cls: "border-red-500/40 text-red-500", icon: XCircle, tint: "text-red-500" },
  running: { text: "running", cls: "border-blue-500/40 text-blue-400", icon: Play, tint: "text-blue-400" },
} satisfies Record<string, Badge>;
const activeBadge = (text: string): Badge => ({ text, cls: "border-border text-muted-foreground", icon: ListTodo, tint: "text-muted-foreground" });

/** The headline outcome for a task group. Trust the task's LIVE status when we have it;
 *  otherwise infer from events — and weigh TERMINAL signals (completed/aborted) before a
 *  stale `gate_opened`, so a task stopped while parked at a gate reads "stopped", not
 *  "awaiting review". */
function outcome(task: TaskSummary | undefined, events: Activity[]): Badge {
  if (task) {
    if (task.merged) return BADGE.merged;
    if (task.status === "completed") return BADGE.completed;
    if (task.status === "awaiting_human") return BADGE.awaiting;
    if (task.status === "aborted") return BADGE.stopped;
    if (task.status === "planning" || task.status === "executing") return BADGE.running;
    return activeBadge(task.status);
  }
  // No task in the list (deleted / not loaded) — infer, terminal events first. A bare
  // task_completed event can't prove a merge landed, so call it "completed", not "merged".
  if (events.some((e) => e.kind === "task_completed")) return BADGE.completed;
  if (events.some((e) => e.kind === "task_aborted")) return BADGE.stopped;
  if (events.some((e) => e.kind === "gate_opened")) return BADGE.awaiting;
  return activeBadge("active");
}

export function ActivityFeed({
  activity,
  tasks = [],
  max = 8,
  chips = 6,
  emptyText = "No activity yet.",
}: {
  activity: Activity[];
  tasks?: TaskSummary[];
  /** Max task groups to show. */
  max?: number;
  /** Max event chips per task (most recent), shown oldest→newest. */
  chips?: number;
  emptyText?: string;
}) {
  const m = new Map<string, { taskId: string; goal: string; events: Activity[]; latest: number }>();
  for (const a of activity) {
    let g = m.get(a.taskId);
    if (!g) {
      g = { taskId: a.taskId, goal: a.taskGoal, events: [], latest: 0 };
      m.set(a.taskId, g);
    }
    g.events.push(a);
    g.latest = Math.max(g.latest, Date.parse(a.at) || 0);
  }
  const groups = [...m.values()].sort((x, y) => y.latest - x.latest).slice(0, max);

  if (groups.length === 0) return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>;

  return (
    <div className="divide-y">
      {groups.map((g) => {
        const task = tasks.find((t) => t.id === g.taskId);
        const o = outcome(task, g.events);
        const Out = o.icon;
        const recent = g.events.slice(0, chips).reverse(); // events arrive newest-first → show oldest→newest
        const more = g.events.length - recent.length;
        return (
          <div key={g.taskId} className="px-4 py-3">
            <div className="flex items-center gap-2.5">
              <Out className={cn("h-4 w-4 shrink-0", o.tint)} />
              <Link href={`/tasks/${g.taskId}`} className="min-w-0 flex-1 truncate text-sm font-medium transition-colors hover:text-primary">
                {g.goal}
              </Link>
              <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", o.cls)}>{o.text}</span>
              <time className="shrink-0 text-xs text-muted-foreground">{relTime(g.latest)}</time>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[26px]">
              {more > 0 && <span className="text-[11px] text-muted-foreground">+{more} earlier</span>}
              {recent.map((a) => {
                const k = KIND[a.kind] ?? { icon: ActivityIcon, tint: "text-muted-foreground" };
                const I = k.icon;
                return (
                  <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    <I className={cn("h-3 w-3 shrink-0", k.tint)} /> {a.label}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Compact relative time ("3m", "2h", "5d") from an epoch-ms timestamp. */
function relTime(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
