"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, ListTodo, Search, ChevronUp, ChevronDown } from "lucide-react";
import type { TaskSummary } from "@bureau/contracts";
import { listTasks } from "../../lib/api";
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
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spin, setSpin] = useState(false);
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
    setSpin(true);
    setError(null);
    try {
      const t = await listTasks();
      if (alive.current) setTasks(t);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : String(e));
        setTasks([]);
      }
    } finally {
      if (alive.current) setSpin(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEngineEvents((e) => {
    if (e.type === "task_updated") void load();
  });

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
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tasks…"
            className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary/60"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                filter === f.key ? "border-primary/40 bg-primary/10 text-primary" : "bg-background text-muted-foreground hover:bg-accent"
              )}
            >
              {f.label}
              <span className={cn("rounded-full px-1.5 text-[10px]", filter === f.key ? "bg-primary/20" : "bg-muted")}>{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent"
        >
          <RefreshCw className={cn("h-4 w-4", spin && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full caption-bottom text-sm">
            <thead>
              <tr className="border-b">
                <SortHeader label="Goal" col="goal" sort={sort} onSort={toggleSort} className="w-[44%]" />
                <SortHeader label="Status" col="status" sort={sort} onSort={toggleSort} />
                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Steps</th>
                <th className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">Repo</th>
                <SortHeader label="Created" col="created" sort={sort} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {tasks === null && (
                <tr>
                  <td colSpan={5} className="py-16 text-center text-sm text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {tasks !== null && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-16 text-center text-sm text-muted-foreground">
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
                  className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/50"
                >
                  <td className="max-w-0 truncate px-4 py-3 align-middle font-medium">{t.goal}</td>
                  <td className="px-4 py-3 align-middle">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                        STATUS_COLOR[t.status] ?? "border-border text-muted-foreground"
                      )}
                    >
                      {t.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-middle text-muted-foreground">
                    {t.completedStepCount}/{t.stepCount}
                  </td>
                  <td className="px-4 py-3 align-middle text-muted-foreground">
                    {t.repoOwner}/{t.repoName}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-middle text-muted-foreground">{relative(t.createdAt)}</td>
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
