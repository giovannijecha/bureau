"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity as ActivityIcon,
  Loader2,
  CircleDot,
  GitMerge,
  Sparkles,
  ListTodo,
  FolderGit2,
  ArrowRight,
  CheckCircle2,
  type LucideIcon,
} from "lucide-react";
import type { Hub, WorkerStatus, TaskSummary } from "@bureau/contracts";
import { getHub, listTasks } from "../../lib/api";
import { useProjects } from "../../lib/useProjects";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { ActivityFeed } from "../../components/ActivityFeed";
import { workerMeta } from "../../lib/workers";
import { cn } from "../../lib/utils";

export default function HubPage() {
  const { active } = useProjects();
  const [hub, setHub] = useState<Hub | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]); // for the total + the activity feed's outcome badges
  // Latest live output line per capability, from step_progress events.
  const [liveChunk, setLiveChunk] = useState<Record<string, string>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [h, t] = await Promise.all([getHub(), listTasks()]);
      if (alive.current) {
        setHub(h);
        setTasks(t);
      }
    } catch {
      if (alive.current) {
        setHub({ workers: [], activity: [], awaitingReview: [], stats: { activeTasks: 0, awaitingReview: 0, merged: 0 } });
        setTasks([]);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Drop the live line for any worker that isn't running right now, so a freshly
  // started step of the same capability never momentarily shows the PREVIOUS
  // task's last output before its own first chunk arrives.
  useEffect(() => {
    if (!hub) return;
    const liveCaps = new Set<string>(hub.workers.filter((w) => w.live).map((w) => w.capability));
    setLiveChunk((prev) => {
      const next: Record<string, string> = {};
      for (const cap of Object.keys(prev)) if (liveCaps.has(cap)) next[cap] = prev[cap]!;
      return next;
    });
  }, [hub]);

  // Live: a step_progress chunk updates the worker's latest line in place (no
  // refetch); any other lifecycle event re-pulls the floor.
  useEngineEvents((e) => {
    if (e.type === "step_progress") {
      setLiveChunk((prev) => ({ ...prev, [e.capability]: lastLine(e.chunk) || prev[e.capability] || "" }));
      return;
    }
    void load();
  }, load); // re-sync on reconnect / tab-return

  if (!hub) return <div className="h-full overflow-y-auto p-6"><p className="text-sm text-muted-foreground">Loading…</p></div>;

  const liveLines = hub.workers.filter((w) => w.live && liveChunk[w.capability]).map((w) => ({ w, line: liveChunk[w.capability]! }));

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Waiting on you — the decision surface, first and always present (calm when clear). */}
        {hub.awaitingReview.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/5">
            <div className="flex items-center gap-2 border-b border-amber-500/20 px-4 py-3 text-sm font-semibold">
              <CircleDot className="h-4 w-4 text-amber-500" /> Waiting on you
              <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">{hub.awaitingReview.length}</span>
            </div>
            <div className="divide-y divide-amber-500/10">
              {hub.awaitingReview.map((t) => (
                <Link key={t.id} href={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-amber-500/5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.goal}</span>
                  <span className="hidden text-xs text-muted-foreground sm:inline">{t.repoOwner}/{t.repoName}</span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                    Review &amp; merge <ArrowRight className="h-3 w-3" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" /> You&apos;re all caught up — nothing waiting on your review.
          </div>
        )}

        {/* Pulse — live & actionable first. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            icon={hub.stats.activeTasks > 0 ? Loader2 : ActivityIcon}
            label="Active now"
            value={hub.stats.activeTasks}
            tint="text-blue-400"
            ring="bg-blue-500/10"
            spin={hub.stats.activeTasks > 0}
          />
          <Stat icon={CircleDot} label="Awaiting review" value={hub.stats.awaitingReview} tint="text-amber-500" ring="bg-amber-500/10" />
          <Stat icon={GitMerge} label="Merged" value={hub.stats.merged} tint="text-green-500" ring="bg-green-500/10" />
          <Stat icon={ListTodo} label="Total tasks" value={tasks.length} tint="text-foreground" ring="bg-muted" />
        </div>

        {/* The floor — a compact roster; live workers are emphasized and show their output. */}
        <div>
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> The floor
            {liveLines.length === 0 && <span className="text-xs font-normal text-muted-foreground">· all idle</span>}
          </h2>
          <div className="flex flex-wrap gap-2">
            {hub.workers.map((w) => (
              <WorkerChip key={w.capability} w={w} />
            ))}
          </div>
          {liveLines.length > 0 && (
            <div className="mt-2.5 space-y-1 overflow-hidden rounded-lg border bg-card px-3 py-2">
              {liveLines.map(({ w, line }) => (
                <p key={w.capability} className="truncate font-mono text-[11px] text-muted-foreground" title={line}>
                  <span className="font-medium text-blue-400">{w.assignee}</span> · {line}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          {/* Activity feed */}
          <div className="lg:col-span-2">
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
                <ActivityIcon className="h-4 w-4 text-primary" /> Activity
              </div>
              <div className="max-h-[560px] overflow-y-auto">
                <ActivityFeed
                  activity={hub.activity}
                  tasks={tasks}
                  max={10}
                  emptyText="Nothing yet — start a task from the Assistant and watch the floor light up."
                />
              </div>
            </div>
          </div>

          {/* Active project + quick start */}
          <div className="space-y-3">
            <div className="rounded-xl border bg-card p-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Active project</div>
              {active ? (
                <Link href={`/projects/${active.id}`} className="group flex items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FolderGit2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold transition-colors group-hover:text-primary">
                      {active.owner}/{active.name}
                    </div>
                    <div className="text-xs text-muted-foreground">{active.baseBranch}</div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                </Link>
              ) : (
                <Link href="/projects" className="text-sm text-primary hover:underline">
                  Configure a project →
                </Link>
              )}
            </div>
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 p-4 transition-colors hover:bg-primary/10"
            >
              <Sparkles className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-semibold">Talk to Iris</div>
                <div className="text-xs text-muted-foreground">Describe what you need and start a task.</div>
              </div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkerChip({ w }: { w: WorkerStatus }) {
  const Icon = workerMeta(w.capability).icon;
  return (
    <div
      title={w.implemented ? `${w.totalStepCount} step${w.totalStepCount === 1 ? "" : "s"} run` : "not implemented yet"}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors",
        w.live ? "border-blue-500/40 bg-blue-500/5" : "bg-card hover:border-foreground/15"
      )}
    >
      <div className="relative shrink-0">
        <Icon className={cn("h-4 w-4", w.live ? "text-blue-400" : "text-muted-foreground")} />
        {w.live && <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-blue-400 ring-2 ring-card" />}
      </div>
      <span className="text-sm font-medium">{w.assignee}</span>
      {w.live ? (
        <span className="text-xs font-medium text-blue-400">{w.runningStepCount} running</span>
      ) : w.implemented ? (
        <span className="text-xs text-muted-foreground">idle</span>
      ) : (
        <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">soon</span>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tint,
  ring,
  spin = false,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  tint: string;
  ring: string;
  spin?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 transition-colors hover:border-foreground/15">
      <div className="flex items-center gap-3">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", ring)}>
          <Icon className={cn("h-5 w-5", tint, spin && "animate-spin")} />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-bold leading-none tracking-tight">{value}</div>
          <div className="mt-1.5 truncate text-xs text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  );
}

/** The last non-empty line of a chunk — a compact "what it's doing now" line. */
function lastLine(chunk: string): string {
  const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
