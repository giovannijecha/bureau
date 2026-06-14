"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ListTodo, CircleDot, Loader2, CheckCircle2, FolderGit2, ArrowRight, Sparkles } from "lucide-react";
import type { TaskSummary } from "@bureau/contracts";
import { listTasks } from "../../lib/api";
import { useProjects } from "../../lib/useProjects";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
  created: "border-border text-muted-foreground",
  aborted: "border-red-500/40 text-red-500",
};

export default function OverviewPage() {
  const { active } = useProjects();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const load = useCallback(async () => {
    try {
      const list = await listTasks();
      if (alive.current) setTasks(list);
    } catch {
      if (alive.current) setTasks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEngineEvents((e) => {
    if (e.type === "task_updated") void load();
  });

  const list = tasks ?? [];
  const running = list.filter((t) => t.status === "planning" || t.status === "executing").length;
  const awaiting = list.filter((t) => t.status === "awaiting_human").length;
  const completed = list.filter((t) => t.status === "completed").length;
  const recent = [...list].reverse().slice(0, 6);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={ListTodo} label="Total tasks" value={list.length} tint="text-foreground" ring="bg-muted" />
        <Stat icon={Loader2} label="Running" value={running} tint="text-blue-400" ring="bg-blue-500/10" spin={running > 0} />
        <Stat icon={CircleDot} label="Awaiting review" value={awaiting} tint="text-amber-500" ring="bg-amber-500/10" />
        <Stat icon={CheckCircle2} label="Completed" value={completed} tint="text-green-500" ring="bg-green-500/10" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Recent tasks */}
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="text-sm font-semibold">Recent tasks</span>
              <Link href="/tasks" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                All tasks <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            {tasks === null ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">Loading…</p>
            ) : recent.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                <Sparkles className="h-6 w-6 opacity-40" />
                No tasks yet — start one from the Assistant.
              </div>
            ) : (
              <div className="divide-y">
                {recent.map((t) => (
                  <Link key={t.id} href={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                    <span className="min-w-0 flex-1 truncate text-sm">{t.goal}</span>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                      {t.repoOwner}/{t.repoName}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
                        STATUS_COLOR[t.status] ?? "border-border text-muted-foreground"
                      )}
                    >
                      {t.status.replace(/_/g, " ")}
                    </span>
                  </Link>
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

function Stat({
  icon: Icon,
  label,
  value,
  tint,
  ring,
  spin = false,
}: {
  icon: typeof ListTodo;
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
