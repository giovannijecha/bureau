"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FolderGit2, GitBranch, Check, ExternalLink, Loader2, CircleDot, GitMerge, ListTodo } from "lucide-react";
import type { TaskSummary } from "@bureau/contracts";
import { useProjects } from "../../lib/useProjects";
import { listTasks } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

interface RepoStats {
  total: number;
  active: number;
  awaiting: number;
  merged: number;
}

function emptyStats(): RepoStats {
  return { total: 0, active: 0, awaiting: 0, merged: 0 };
}

export default function ProjectsPage() {
  const { projects, active, setActiveId, error } = useProjects();
  const [byRepo, setByRepo] = useState<Map<string, RepoStats>>(new Map());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const tasks = await listTasks();
      const map = new Map<string, RepoStats>();
      for (const t of tasks) {
        const key = `${t.repoOwner}/${t.repoName}`;
        const s = map.get(key) ?? emptyStats();
        s.total++;
        if (t.status === "planning" || t.status === "executing") s.active++;
        else if (t.status === "awaiting_human") s.awaiting++;
        if (t.merged) s.merged++;
        map.set(key, s);
      }
      if (alive.current) setByRepo(map);
    } catch {
      /* leave stats empty on error */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEngineEvents((e) => {
    if (e.type === "task_updated") void load();
  });

  return (
    <div className="h-full overflow-y-auto p-6">
      <p className="mb-4 text-sm text-muted-foreground">Pick the active project — Iris scopes her work to it in the Assistant.</p>

      {error && <p className="mb-4 text-sm text-destructive">⚠ {error}</p>}

      {projects.length === 0 && !error ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
          <FolderGit2 className="h-6 w-6 opacity-40" />
          No projects configured. Set <code className="font-mono">BUREAU_PROJECTS</code> on the engine.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => {
            const isActive = active?.id === p.id;
            const stats = byRepo.get(`${p.owner}/${p.name}`) ?? emptyStats();
            return (
              <div key={p.id} className={cn("flex flex-col rounded-xl border bg-card p-4 transition-colors", isActive && "border-primary/40")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FolderGit2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">
                        {p.owner}/{p.name}
                      </span>
                      {isActive && (
                        <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <GitBranch className="h-3 w-3" />
                      {p.baseBranch}
                    </div>
                  </div>
                </div>

                {/* Live task stats for this repo */}
                <div className="mt-4 grid grid-cols-4 gap-2 rounded-lg border bg-muted/30 p-2.5 text-center">
                  <Mini icon={ListTodo} value={stats.total} label="tasks" tint="text-foreground" />
                  <Mini icon={Loader2} value={stats.active} label="active" tint="text-blue-400" spin={stats.active > 0} />
                  <Mini icon={CircleDot} value={stats.awaiting} label="review" tint="text-amber-500" />
                  <Mini icon={GitMerge} value={stats.merged} label="merged" tint="text-green-500" />
                </div>

                <div className="mt-4 flex items-center gap-2">
                  {isActive ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                      <Check className="h-3.5 w-3.5" />
                      Selected in Assistant
                    </span>
                  ) : (
                    <button
                      onClick={() => setActiveId(p.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-accent"
                    >
                      Set active
                    </button>
                  )}
                  <Link href="/tasks" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                    View tasks
                  </Link>
                  <a
                    href={`https://github.com/${p.owner}/${p.name}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Mini({ icon: Icon, value, label, tint, spin = false }: { icon: typeof ListTodo; value: number; label: string; tint: string; spin?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <Icon className={cn("h-3.5 w-3.5", tint, spin && value > 0 && "animate-spin")} />
      <span className="text-sm font-semibold leading-none">{value}</span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}
