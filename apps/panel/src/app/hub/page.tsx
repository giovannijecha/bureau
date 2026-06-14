"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity as ActivityIcon,
  Loader2,
  CircleDot,
  GitMerge,
  Sparkles,
  Plus,
  Play,
  CheckCircle2,
  XCircle,
  Check,
  ClipboardList,
  Pencil,
  FlaskConical,
  ScanEye,
  FileText,
  type LucideIcon,
} from "lucide-react";
import type { Hub, WorkerStatus, Activity } from "@bureau/contracts";
import { getHub } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

const WORKER_ICON: Record<string, LucideIcon> = {
  plan: ClipboardList,
  edit: Pencil,
  test: FlaskConical,
  review: ScanEye,
  document: FileText,
};

// Each activity kind gets an icon + tint so the feed reads at a glance.
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

export default function HubPage() {
  const [hub, setHub] = useState<Hub | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const h = await getHub();
      if (alive.current) setHub(h);
    } catch {
      if (alive.current) setHub({ workers: [], activity: [], awaitingReview: [], stats: { activeTasks: 0, awaitingReview: 0, merged: 0 } });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: any task lifecycle event re-pulls the floor.
  useEngineEvents(() => void load());

  if (!hub) return <div className="h-full overflow-y-auto p-6"><p className="text-sm text-muted-foreground">Loading…</p></div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Pulse */}
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Pulse icon={Loader2} label="Active now" value={hub.stats.activeTasks} tint="text-blue-400" ring="bg-blue-500/10" spin={hub.stats.activeTasks > 0} />
        <Pulse icon={CircleDot} label="Waiting on you" value={hub.stats.awaitingReview} tint="text-amber-500" ring="bg-amber-500/10" />
        <Pulse icon={GitMerge} label="Merged" value={hub.stats.merged} tint="text-green-500" ring="bg-green-500/10" />
      </div>

      {/* Worker floor */}
      <div className="mb-5">
        <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-primary" /> The floor
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {hub.workers.map((w) => (
            <WorkerCard key={w.capability} w={w} />
          ))}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Activity feed */}
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
              <ActivityIcon className="h-4 w-4 text-primary" /> Activity
            </div>
            {hub.activity.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
                <ActivityIcon className="h-6 w-6 opacity-40" />
                Nothing yet — start a task from the Assistant and watch the floor light up.
              </div>
            ) : (
              <div className="divide-y">
                {hub.activity.map((a) => (
                  <ActivityRow key={a.id} a={a} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Waiting on you */}
        <div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
              <CircleDot className="h-4 w-4 text-amber-500" /> Waiting on you
            </div>
            {hub.awaitingReview.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing needs your decision.</p>
            ) : (
              <div className="divide-y">
                {hub.awaitingReview.map((t) => (
                  <Link key={t.id} href={`/tasks/${t.id}`} className="block px-4 py-3 transition-colors hover:bg-muted/50">
                    <div className="truncate text-sm font-medium">{t.goal}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t.repoOwner}/{t.repoName} · review &amp; merge
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkerCard({ w }: { w: WorkerStatus }) {
  const Icon = WORKER_ICON[w.capability] ?? Pencil;
  return (
    <div className={cn("rounded-xl border bg-card p-4 transition-colors", w.live ? "border-blue-500/40" : "hover:border-foreground/15")}>
      <div className="flex items-center gap-3">
        <div className={cn("relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", w.live ? "bg-blue-500/10 text-blue-400" : "bg-muted text-muted-foreground")}>
          <Icon className="h-5 w-5" />
          {w.live && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400 ring-2 ring-card" />}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{w.assignee}</div>
          <div className="truncate text-xs text-muted-foreground capitalize">{w.capability}</div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        {w.implemented ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-green-500/40 px-1.5 py-px font-medium text-green-500">live</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-muted-foreground">soon</span>
        )}
        <span className={cn("text-muted-foreground", w.live && "font-medium text-blue-400")}>
          {w.live ? `${w.runningStepCount} running` : "idle"}
        </span>
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
      <time className="shrink-0 text-xs text-muted-foreground">{relTime(a.at)}</time>
    </Link>
  );
}

function Pulse({
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
    <div className="rounded-xl border bg-card p-4">
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

/** Compact relative time ("3m", "2h", "5d") from an ISO timestamp. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
