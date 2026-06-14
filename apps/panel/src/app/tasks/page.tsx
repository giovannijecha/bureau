"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, ListTodo } from "lucide-react";
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

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spin, setSpin] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setSpin(true);
    try {
      const list = await listTasks();
      if (alive.current) setTasks(list);
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

  // Live: refresh the list whenever a task changes state.
  useEngineEvents((e) => {
    if (e.type === "task_updated") void load();
  });

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tasks === null ? "Loading…" : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
        </p>
        <button
          onClick={() => void load()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", spin && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full caption-bottom text-sm">
          <thead>
            <tr className="border-b">
              {["Goal", "Status", "Steps", "Open gates", "Repo", "Created"].map((h) => (
                <th key={h} className="h-10 px-4 text-left align-middle text-xs font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
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
            {tasks?.length === 0 && (
              <tr>
                <td colSpan={6} className="py-16 text-center text-sm text-muted-foreground">
                  {error ? (
                    `⚠ ${error}`
                  ) : (
                    <span className="inline-flex flex-col items-center gap-2">
                      <ListTodo className="h-6 w-6 opacity-40" />
                      No tasks yet — start one from the Assistant.
                    </span>
                  )}
                </td>
              </tr>
            )}
            {tasks?.map((t) => (
              <tr
                key={t.id}
                onClick={() => router.push(`/tasks/${t.id}`)}
                className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/50"
              >
                <td className="max-w-md truncate px-4 py-3 align-middle">{t.goal}</td>
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
                <td className="px-4 py-3 align-middle text-muted-foreground">{t.pendingGates}</td>
                <td className="px-4 py-3 align-middle text-muted-foreground">
                  {t.repoOwner}/{t.repoName}
                </td>
                <td className="px-4 py-3 align-middle text-muted-foreground">{relative(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
