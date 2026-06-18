"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { ListTodo, Search, ChevronUp, ChevronDown, Play, Square, Eye, GitMerge, Trash2, Loader2, AlertCircle } from "lucide-react";
import type { TaskSummary } from "@bureau/contracts";
import { listTasks, startTask, stopTask, mergeOpenPr, deleteTask } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { useEngineOnline } from "../../lib/useEngineOnline";
import { useConfirm } from "../../components/ConfirmDialog";
import { cn } from "../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
  created: "border-border text-muted-foreground",
  aborted: "border-red-500/40 text-red-500",
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "awaiting_human", label: "Awaiting review" },
  { key: "running", label: "Running" },
  { key: "completed", label: "Completed" },
  { key: "aborted", label: "Stopped" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];
type SortCol = "goal" | "status" | "created";

const isRunning = (s: string) => s === "planning" || s === "executing";

function matchesFilter(t: TaskSummary, f: FilterKey): boolean {
  if (f === "all") return true;
  if (f === "running") return isRunning(t.status);
  return t.status === f;
}

export default function TasksPage() {
  const router = useRouter();
  const online = useEngineOnline();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "created", dir: "desc" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await listTasks();
      if (alive.current) setTasks(t);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e));
        setTasks([]);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The list is LIVE — engine events refresh it, so there's no manual refresh button.
  // `load` on reconnect re-syncs anything missed while the socket was down (frames aren't
  // replayed), and a focus/visibility refetch catches staleness when returning to the tab.
  useEngineEvents((e) => {
    if (e.type === "task_updated") void load();
  }, load);

  useEffect(() => {
    const refetchIfVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refetchIfVisible);
    window.addEventListener("focus", refetchIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refetchIfVisible);
      window.removeEventListener("focus", refetchIfVisible);
    };
  }, [load]);

  const counts = useMemo(() => {
    const all = tasks ?? [];
    return {
      all: all.length,
      awaiting_human: all.filter((t) => t.status === "awaiting_human").length,
      running: all.filter((t) => isRunning(t.status)).length,
      completed: all.filter((t) => t.status === "completed").length,
      aborted: all.filter((t) => t.status === "aborted").length,
    } as Record<FilterKey, number>;
  }, [tasks]);

  const rows = useMemo(() => {
    let r = (tasks ?? []).filter((t) => matchesFilter(t, filter));
    const s = q.trim().toLowerCase();
    if (s) r = r.filter((t) => t.goal.toLowerCase().includes(s) || `${t.repoOwner}/${t.repoName}`.toLowerCase().includes(s));
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...r].sort((a, b) => {
      if (sort.col === "goal") return a.goal.localeCompare(b.goal) * dir;
      if (sort.col === "status") return a.status.localeCompare(b.status) * dir;
      return (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * dir;
    });
  }, [tasks, filter, q, sort]);

  const toggleSort = (col: SortCol) =>
    setSort((s) => (s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" }));

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar — subtle search + a segmented filter; the list is live (no refresh button). */}
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
        <div className="relative min-w-[200px] max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tasks…"
            className="h-9 w-full rounded-lg border border-transparent bg-muted/50 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary/40 focus:bg-background"
          />
        </div>
        <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-muted/40 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                filter === f.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f.label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] tabular-nums",
                  filter === f.key ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                )}
              >
                {counts[f.key]}
              </span>
            </button>
          ))}
        </div>
        <span
          className="ml-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex"
          title={online === false ? "Engine offline — the list may be stale" : "The list updates automatically as tasks change"}
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full", online === true ? "bg-green-500" : online === false ? "bg-red-500" : "bg-muted-foreground/40")}
          />
          {online === true ? "Live" : online === false ? "Offline" : "Connecting…"}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full caption-bottom text-sm">
            <thead>
              <tr className="border-b">
                <SortHeader label="Goal" col="goal" sort={sort} onSort={toggleSort} className="w-[40%]" />
                <SortHeader label="Status" col="status" sort={sort} onSort={toggleSort} />
                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Steps</th>
                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Repo</th>
                <SortHeader label="Created" col="created" sort={sort} onSort={toggleSort} />
                <th className="h-10 w-0 px-4" />
              </tr>
            </thead>
            <tbody>
              {tasks === null && (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-sm text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {tasks !== null && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-sm text-muted-foreground">
                    {error ? (
                      `⚠ ${error}`
                    ) : (
                      <span className="inline-flex flex-col items-center gap-2">
                        <ListTodo className="h-6 w-6 opacity-40" />
                        {q || filter !== "all" ? "No tasks match." : "No tasks yet — start one from the Assistant."}
                      </span>
                    )}
                  </td>
                </tr>
              )}
              {rows.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => router.push(`/tasks/${t.id}`)}
                  className="group cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/50"
                >
                  <td className="max-w-0 truncate px-4 py-3 align-middle font-medium">{t.goal}</td>
                  <td className="px-4 py-3 align-middle">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                        t.merged ? STATUS_COLOR.completed : STATUS_COLOR[t.status] ?? "border-border text-muted-foreground"
                      )}
                    >
                      {t.merged ? "merged" : t.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-middle text-muted-foreground">
                    {t.completedStepCount}/{t.stepCount}
                  </td>
                  <td className="px-4 py-3 align-middle text-muted-foreground">
                    {t.repoOwner}/{t.repoName}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-middle text-muted-foreground">{relative(t.createdAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3 align-middle">
                    <TaskActions task={t} onChanged={load} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {tasks !== null && rows.length > 0 && (
          <p className="mt-3 text-right text-xs text-muted-foreground">
            {rows.length} of {tasks.length} task{tasks.length === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
}

// Quick, status-aware actions you can fire straight from the row — no need to open the task.
// The destructive/irreversible ones (stop, merge, delete) ask for confirmation first.
function TaskActions({ task, onChanged }: { task: TaskSummary; onChanged: () => void }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const swallow = (e: MouseEvent) => e.stopPropagation(); // never trigger the row's open-on-click

  async function run(fn: () => Promise<unknown>, confirmOpts?: Parameters<typeof confirm>[0]) {
    if (confirmOpts) {
      const ok = await confirm(confirmOpts);
      if (!ok) return;
    }
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged(); // refresh now (engine events also fire, but delete may not)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  let primary: ReactNode = null;
  if (task.status === "created") {
    primary = <ActionBtn icon={Play} label="Start" busy={busy} onClick={(e) => { swallow(e); void run(() => startTask(task.id)); }} />;
  } else if (isRunning(task.status)) {
    primary = (
      <ActionBtn
        icon={Square}
        label="Stop"
        tone="danger"
        busy={busy}
        onClick={(e) => {
          swallow(e);
          void run(() => stopTask(task.id), { title: "Stop this task?", description: "The running step is aborted — you can't resume it.", confirmLabel: "Stop", variant: "destructive" });
        }}
      />
    );
  } else if (task.status === "awaiting_human") {
    primary = <ActionBtn icon={Eye} label="Review" tone="amber" onClick={(e) => { swallow(e); router.push(`/tasks/${task.id}`); }} />;
  } else if (task.prOpen) {
    primary = (
      <ActionBtn
        icon={GitMerge}
        label="Merge"
        tone="primary"
        busy={busy}
        onClick={(e) => {
          swallow(e);
          void run(() => mergeOpenPr(task.id), { title: "Merge to main?", description: "Squash-merge this task's open PR into main.", confirmLabel: "Merge" });
        }}
      />
    );
  }

  return (
    <div className="flex items-center justify-end gap-1" onClick={swallow}>
      {err && (
        <span title={err} className="text-destructive">
          <AlertCircle className="h-4 w-4" />
        </span>
      )}
      {primary}
      <button
        title="Delete task"
        aria-label="Delete task"
        disabled={busy}
        onClick={(e) => {
          swallow(e);
          void run(() => deleteTask(task.id), {
            title: "Delete this task?",
            description: "The task and its history are permanently removed. This can't be undone.",
            confirmLabel: "Delete",
            variant: "destructive",
          });
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  busy = false,
  tone = "default",
}: {
  icon: typeof Play;
  label: string;
  onClick: (e: MouseEvent) => void;
  busy?: boolean;
  tone?: "default" | "primary" | "amber" | "danger";
}) {
  const tones: Record<string, string> = {
    default: "border bg-background text-foreground hover:bg-accent",
    primary: "bg-primary text-primary-foreground hover:bg-primary/90",
    amber: "border border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400",
    danger: "border bg-background text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
  };
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50", tones[tone])}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

function SortHeader({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string;
  col: SortCol;
  sort: { col: SortCol; dir: "asc" | "desc" };
  onSort: (col: SortCol) => void;
  className?: string;
}) {
  const active = sort.col === col;
  return (
    <th className={cn("h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground", className)}>
      <button onClick={() => onSort(col)} className="inline-flex items-center gap-1 transition-colors hover:text-foreground">
        {label}
        {active ? (
          sort.dir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ChevronDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </th>
  );
}

function relative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
