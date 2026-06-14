"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ListTodo,
  CircleDot,
  Loader2,
  GitMerge,
  FolderGit2,
  ArrowRight,
  Sparkles,
  Activity as ActivityIcon,
  Plus,
  Play,
  CheckCircle2,
  XCircle,
  Check,
  type LucideIcon,
} from "lucide-react";
import type { Hub, TaskSummary, Activity } from "@bureau/contracts";
import { getHub, listTasks } from "../../lib/api";
import { useProjects } from "../../lib/useProjects";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

const ACTIVITY: Record<string, { icon: LucideIcon; tint: string }> = {
  task_created: { icon: Plus, tint: "text-muted-foreground" },
  step_started: { icon: Play, tint: "text-blue-400" },
  step_completed: { icon: CheckCircle2, tint: "text-green-500" },
  step_failed: { icon: XCircle, tint: "text-red-500" },
  gate_opened: { icon: CircleDot, tint: "text-amber-500" },
  gate_decided: { icon: Check, tint: "text-green-500" },
  task_completed: { icon: GitMerge, tint: "text-green-500" },
  task_aborted: { icon: XCircle, tint: "text-red-500" },
};

export default function OverviewPage() {
  const { active } = useProjects();
  const [hub, setHub] = useState<Hub | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [h, tasks] = await Promise.all([getHub(), listTasks()]);
      if (alive.current) {
        setHub(h);
        setTotal(tasks.length);
      }
    } catch {
      if (alive.current) {
        setHub({ workers: [], activity: [], awaitingReview: [], stats: { activeTasks: 0, awaitingReview: 0, merged: 0 } });
        setTotal(0);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEngineEvents((e) => {
    if (e.type === "task_updated" || e.type === "gate_opened" || e.type === "step_completed") void load();
  });

  const stats = hub?.stats ?? { activeTasks: 0, awaitingReview: 0, merged: 0 };

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Waiting on you — the decision surface, first. */}
      {hub && hub.awaitingReview.length > 0 && (
        <div className="mb-5 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/5">
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
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={ListTodo} label="Total tasks" value={total ?? 0} tint="text-foreground" ring="bg-muted" />
        <Stat icon={Loader2} label="Active now" value={stats.activeTasks} tint="text-blue-400" ring="bg-blue-500/10" spin={stats.activeTasks > 0} />
        <Stat icon={CircleDot} label="Awaiting review" value={stats.awaitingReview} tint="text-amber-500" ring="bg-amber-500/10" />
        <Stat icon={GitMerge} label="Merged" value={stats.merged} tint="text-green-500" ring="bg-green-500/10" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Activity */}
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <ActivityIcon className="h-4 w-4 text-primary" /> Recent activity
              </span>
              <Link href="/hub" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                Open Hub <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            {hub === null ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</p>
            ) : hub.activity.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                <Sparkles className="h-6 w-6 opacity-40" />
                No activity yet — start a task from the Assistant.
              </div>
            ) : (
              <div className="divide-y">
                {hub.activity.slice(0, 8).map((a) => (
                  <ActivityRow key={a.id} a={a} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Active project + quick start */}
        <div className="space-y-3">
          <div className="rounded-xl border bg-card p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Active project</div>
            {active ? (
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FolderGit2 className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {active.owner}/{active.name}
                  </div>
                  <div className="text-xs text-muted-foreground">{active.baseBranch}</div>
                </div>
              </div>
            ) : (
              <Link href="/projects" className="text-sm text-primary hover:underline">
                Choose a project →
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
  );
}

function ActivityRow({ a }: { a: Activity }) {
  const meta = ACTIVITY[a.kind] ?? { icon: ActivityIcon, tint: "text-muted-foreground" };
  const Icon = meta.icon;
  return (
    <Link href={`/tasks/${a.taskId}`} className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.tint)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{a.label}</div>
        <div className="truncate text-xs text-muted-foreground">{a.taskGoal}</div>
      </div>
    </Link>
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
