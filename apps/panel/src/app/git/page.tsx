"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GitBranch, GitMerge, ExternalLink, FolderGit2 } from "lucide-react";
import type { TaskSummary } from "@bureau/contracts";
import { listTasks } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
};

export default function GitPage() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const t = await listTasks();
      if (alive.current) setTasks(t);
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

  const byRepo = new Map<string, TaskSummary[]>();
  for (const t of tasks ?? []) {
    if (t.status === "created" || t.status === "aborted") continue; // no live branch / merge
    const key = `${t.repoOwner}/${t.repoName}`;
    const arr = byRepo.get(key);
    if (arr) arr.push(t);
    else byRepo.set(key, [t]);
  }
  const repos = [...byRepo.entries()];

  return (
    <div className="h-full overflow-y-auto p-6">
      {tasks === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : repos.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
          <GitBranch className="h-6 w-6 opacity-40" />
          No branches yet. Start a task from the Assistant — each runs in its own worktree and branch.
        </div>
      ) : (
        <div className="mx-auto max-w-4xl space-y-5">
          {repos.map(([repo, ts]) => (
            <div key={repo} className="overflow-hidden rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="h-4 w-4 text-primary" />
                  <span className="font-semibold">{repo}</span>
                </div>
                <a
                  href={`https://github.com/${repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  GitHub <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div className="divide-y">
                {ts.map((t) => (
                  <Link key={t.id} href={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                    {t.status === "completed" ? (
                      <GitMerge className="h-4 w-4 shrink-0 text-green-500" />
                    ) : (
                      <GitBranch className="h-4 w-4 shrink-0 text-amber-500" />
                    )}
                    <code className="shrink-0 font-mono text-xs text-muted-foreground">bureau/task-{t.id.slice(0, 8)}</code>
                    <span className="min-w-0 flex-1 truncate text-sm">{t.goal}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
                        STATUS_COLOR[t.status] ?? "border-border text-muted-foreground"
                      )}
                    >
                      {t.status === "completed" ? "merged" : t.status.replace(/_/g, " ")}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
