"use client";

// A project's workspace: what's been done (tasks + status), recent changes, and an
// embedded Iris scoped to the repo. Shared by /projects (the active project) and
// /projects/[projectId] (a specific one). Switching projects is done from the global
// header switcher — so there's no in-page "all projects" back-link.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  FolderGit2,
  GitBranch,
  GitCommit,
  GitMerge,
  ListTodo,
  CircleDot,
  Activity,
  Loader2,
  ExternalLink,
} from "lucide-react";
import type { TaskSummary, GitInfo } from "@bureau/contracts";
import { useProjects } from "../lib/useProjects";
import { listTasks, getGitInfo } from "../lib/api";
import { useEngineEvents } from "../lib/useEngineEvents";
import { IrisDock } from "./IrisDock";
import { cn } from "../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
  aborted: "border-red-500/40 text-red-500",
};

export function ProjectWorkspace({ projectId }: { projectId: string | null }) {
  const { projects, activeId, setActiveId, error } = useProjects();
  const project = projectId ? projects.find((p) => p.id === projectId) ?? null : null;
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [git, setGit] = useState<GitInfo | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  // Opening a specific project's workspace scopes it active (Iris + git follow it).
  useEffect(() => {
    if (project && activeId !== project.id) setActiveId(project.id);
  }, [project, activeId, setActiveId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const all = await listTasks();
      if (alive.current) setTasks(all);
    } catch {
      if (alive.current) setTasks([]);
    }
    try {
      const g = await getGitInfo(projectId);
      if (alive.current) setGit(g);
    } catch {
      if (alive.current) setGit(null);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEngineEvents((e) => {
    if (e.type === "task_updated") void load();
  });

  // No project to show — either none configured, or none picked yet.
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-2 rounded-xl border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          <FolderGit2 className="h-7 w-7 opacity-40" />
          {error ? (
            <span className="text-destructive">⚠ {error}</span>
          ) : projects.length === 0 ? (
            <>
              No projects configured. Set <code className="font-mono">BUREAU_PROJECTS</code> on the engine.
            </>
          ) : (
            <>Pick a repository from the switcher in the top bar to open its workspace.</>
          )}
        </div>
      </div>
    );
  }

  const mine = (tasks ?? []).filter((t) => t.repoOwner === project.owner && t.repoName === project.name);
  const stats = {
    total: mine.length,
    active: mine.filter((t) => t.status === "planning" || t.status === "executing").length,
    review: mine.filter((t) => t.status === "awaiting_human").length,
    merged: mine.filter((t) => t.merged).length,
  };

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {/* Header */}
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FolderGit2 className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">
              {project.owner}/{project.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <GitBranch className="h-3 w-3" /> {git?.branch ?? project.baseBranch}
              </span>
              <span className={cn("inline-flex items-center gap-1", git === null ? "" : git.cloned ? "text-green-500" : "text-amber-500")}>
                <span className={cn("h-1.5 w-1.5 rounded-full", git === null ? "bg-muted-foreground/40" : git.cloned ? "bg-green-500" : "bg-amber-500")} />
                {git === null ? "—" : git.cloned ? "cloned" : "not cloned"}
              </span>
              <a
                href={`https://github.com/${project.owner}/${project.name}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              >
                GitHub <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={ListTodo} value={stats.total} label="tasks" tint="text-foreground" />
          <Stat icon={stats.active > 0 ? Loader2 : Activity} value={stats.active} label="active" tint="text-blue-400" spin={stats.active > 0} />
          <Stat icon={CircleDot} value={stats.review} label="in review" tint="text-amber-500" />
          <Stat icon={GitMerge} value={stats.merged} label="merged" tint="text-green-500" />
        </div>

        {/* Work on this project */}
        <h2 className="mb-2.5 text-sm font-semibold">Work on this project</h2>
        {tasks === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : mine.length === 0 ? (
          <div className="rounded-xl border bg-card py-10 text-center text-sm text-muted-foreground">
            Nothing yet. Chat with Iris (right) to start a task on this project.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <ul className="divide-y">
              {mine.map((t) => (
                <li key={t.id}>
                  <Link href={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50">
                    {t.merged ? <GitMerge className="h-4 w-4 shrink-0 text-green-500" /> : <ListTodo className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate text-sm">{t.goal}</span>
                    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium", t.merged ? STATUS_COLOR.completed : STATUS_COLOR[t.status] ?? "border-border text-muted-foreground")}>
                      {t.merged ? "merged" : t.status.replace(/_/g, " ")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recent commits */}
        {git?.cloned && git.commits.length > 0 && (
          <>
            <h2 className="mb-2.5 mt-5 text-sm font-semibold">Recent commits</h2>
            <div className="overflow-hidden rounded-xl border bg-card">
              <ul className="divide-y">
                {git.commits.slice(0, 6).map((c) => (
                  <li key={c.hash} className="flex items-center gap-3 px-4 py-2.5">
                    <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <code className="shrink-0 font-mono text-xs text-primary">{c.hash}</code>
                    <span className="min-w-0 flex-1 truncate text-sm">{c.subject}</span>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{c.date}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>

      {/* Iris, scoped to this project (hidden on narrow screens) */}
      <div className="hidden w-[380px] shrink-0 flex-col overflow-hidden border-l lg:flex">
        <IrisDock
          projectId={project.id}
          emptyHint="This is your workspace for the project. Ask Iris what to build, review what's been done, or have her propose a task — she's scoped to this repo."
        />
      </div>
    </div>
  );
}

function Stat({ icon: Icon, value, label, tint, spin = false }: { icon: typeof ListTodo; value: number; label: string; tint: string; spin?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
      <Icon className={cn("h-5 w-5 shrink-0", tint, spin && value > 0 && "animate-spin")} />
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-none">{value}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
