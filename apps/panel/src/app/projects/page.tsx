"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FolderGit2,
  GitBranch,
  Check,
  ExternalLink,
  Loader2,
  CircleDot,
  GitMerge,
  ListTodo,
  Activity,
  Sparkles,
  Terminal as TerminalIcon,
  GitCommit,
  LayoutDashboard,
} from "lucide-react";
import type { TaskSummary, GitInfo } from "@bureau/contracts";
import { useProjects } from "../../lib/useProjects";
import { listTasks, getGitInfo } from "../../lib/api";
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
  const router = useRouter();
  const { projects, active, setActiveId, error } = useProjects();
  const [byRepo, setByRepo] = useState<Map<string, RepoStats>>(new Map());
  const [gitById, setGitById] = useState<Record<string, GitInfo | null>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadStats = useCallback(async () => {
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

  // Each project's live git state (clone status + last commit), fetched in parallel.
  const loadGit = useCallback(async (ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          const g = await getGitInfo(id);
          if (alive.current) setGitById((prev) => ({ ...prev, [id]: g }));
        } catch {
          if (alive.current) setGitById((prev) => ({ ...prev, [id]: null }));
        }
      })
    );
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    if (projects.length > 0) void loadGit(projects.map((p) => p.id));
  }, [projects, loadGit]);

  useEngineEvents((e) => {
    if (e.type === "task_updated") void loadStats();
  });

  // Scope a project active, then jump to a section.
  function go(projectId: string, href: string) {
    setActiveId(projectId);
    router.push(href);
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <p className="mb-4 text-sm text-muted-foreground">Your repositories — pick the active one (Iris scopes her work to it) and jump straight in.</p>

      {error && <p className="mb-4 text-sm text-destructive">⚠ {error}</p>}

      {projects.length === 0 && !error ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
          <FolderGit2 className="h-6 w-6 opacity-40" />
          No projects configured. Set <code className="font-mono">BUREAU_PROJECTS</code> on the engine.
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {projects.map((p) => {
            const isActive = active?.id === p.id;
            const stats = byRepo.get(`${p.owner}/${p.name}`) ?? emptyStats();
            const git = gitById[p.id];
            const lastCommit = git?.commits[0];
            return (
              <div key={p.id} className={cn("flex flex-col rounded-xl border bg-card p-4 transition-colors", isActive && "border-primary/40")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FolderGit2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/projects/${p.id}`}
                        onClick={() => setActiveId(p.id)}
                        className="truncate font-semibold transition-colors hover:text-primary"
                      >
                        {p.owner}/{p.name}
                      </Link>
                      {isActive && (
                        <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <GitBranch className="h-3 w-3" />
                        {git?.branch ?? p.baseBranch}
                      </span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1",
                          git === undefined ? "" : git?.cloned ? "text-green-500" : "text-amber-500"
                        )}
                      >
                        <span className={cn("h-1.5 w-1.5 rounded-full", git === undefined ? "bg-muted-foreground/40" : git?.cloned ? "bg-green-500" : "bg-amber-500")} />
                        {git === undefined ? "checking…" : git?.cloned ? "cloned" : "not cloned"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Last commit */}
                {lastCommit && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                    <GitCommit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <code className="shrink-0 font-mono text-primary">{lastCommit.hash}</code>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{lastCommit.subject}</span>
                  </div>
                )}

                {/* Live task stats for this repo */}
                <div className="mt-3 grid grid-cols-4 gap-2 rounded-lg border bg-muted/30 p-2.5 text-center">
                  <Mini icon={ListTodo} value={stats.total} label="tasks" tint="text-foreground" />
                  <Mini icon={stats.active > 0 ? Loader2 : Activity} value={stats.active} label="active" tint="text-blue-400" spin={stats.active > 0} />
                  <Mini icon={CircleDot} value={stats.awaiting} label="review" tint="text-amber-500" />
                  <Mini icon={GitMerge} value={stats.merged} label="merged" tint="text-green-500" />
                </div>

                {/* Quick actions — each scopes this project active first. */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Action icon={LayoutDashboard} label="Open" onClick={() => go(p.id, `/projects/${p.id}`)} primary />
                  <Action icon={Sparkles} label="Chat" onClick={() => go(p.id, "/")} />
                  <Action icon={GitBranch} label="Git" onClick={() => go(p.id, "/git")} />
                  <Action icon={TerminalIcon} label="Terminal" onClick={() => go(p.id, "/terminal")} />
                  <Action icon={ListTodo} label="Tasks" onClick={() => go(p.id, "/tasks")} />
                  {!isActive && (
                    <button
                      onClick={() => setActiveId(p.id)}
                      className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent"
                    >
                      Set active
                    </button>
                  )}
                  {isActive && (
                    <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary">
                      <Check className="h-3.5 w-3.5" /> Active
                    </span>
                  )}
                  <a
                    href={`https://github.com/${p.owner}/${p.name}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on GitHub"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
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

function Action({ icon: Icon, label, onClick, primary = false }: { icon: typeof ListTodo; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        primary ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border bg-background hover:bg-accent"
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", primary ? "" : "text-primary")} />
      {label}
    </button>
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
