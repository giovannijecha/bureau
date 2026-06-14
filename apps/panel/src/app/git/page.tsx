"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GitBranch, GitMerge, GitCommit, ExternalLink, FolderGit2, Loader2 } from "lucide-react";
import type { TaskSummary, GitInfo } from "@bureau/contracts";
import { listTasks, getGitInfo } from "../../lib/api";
import { useProjects } from "../../lib/useProjects";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
};

export default function GitPage() {
  const { active, activeId } = useProjects();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitErr, setGitErr] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const t = await listTasks();
      if (alive.current) setTasks(t);
    } catch {
      if (alive.current) setTasks([]);
    }
  }, []);

  const loadGit = useCallback(async (projectId?: string) => {
    setGit(null);
    setGitErr(false);
    try {
      const g = await getGitInfo(projectId);
      if (alive.current) setGit(g);
    } catch {
      if (alive.current) setGitErr(true);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    void loadGit(activeId ?? undefined);
  }, [activeId, loadGit]);

  useEngineEvents((e) => {
    if (e.type === "task_updated") {
      void loadTasks();
      void loadGit(activeId ?? undefined);
    }
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
  const repoSlug = active ? `${active.owner}/${active.name}` : git ? `${git.owner}/${git.name}` : "";

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        {/* Live repository console for the active project */}
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <FolderGit2 className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate font-semibold">{repoSlug || "Repository"}</span>
              {git?.branch && (
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  <GitBranch className="h-3 w-3" /> {git.branch}
                </span>
              )}
            </div>
            {repoSlug && (
              <a
                href={`https://github.com/${repoSlug}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                GitHub <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          {git === null && !gitErr ? (
            <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the repository…
            </p>
          ) : gitErr || !git ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">Couldn&apos;t read the repository.</p>
          ) : !git.cloned ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              Not cloned yet — start a task or chat with Iris and Bureau clones it on first use.
            </p>
          ) : (
            <div>
              {/* Branches */}
              {git.branches.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-3">
                  <span className="mr-1 text-xs font-medium text-muted-foreground">Branches</span>
                  {git.branches.map((b) => (
                    <span
                      key={b}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                        b === git.baseBranch ? "border-primary/40 text-primary" : "text-muted-foreground"
                      )}
                    >
                      <GitBranch className="h-3 w-3" /> {b}
                    </span>
                  ))}
                </div>
              )}

              {/* Recent commits */}
              <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Recent commits</div>
              {git.commits.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-muted-foreground">No commits yet.</p>
              ) : (
                <ul className="divide-y">
                  {git.commits.map((c) => (
                    <li key={c.hash}>
                      <a
                        href={`https://github.com/${repoSlug}/commit/${c.hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
                      >
                        <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <code className="shrink-0 font-mono text-xs text-primary">{c.hash}</code>
                        <span className="min-w-0 flex-1 truncate text-sm">{c.subject}</span>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                          {c.author} · {c.date}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Agent branches — the worktree branches Bureau's tasks created */}
        <div>
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
            <GitBranch className="h-4 w-4 text-primary" /> Agent branches
          </h2>
          {tasks === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : repos.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-12 text-center text-sm text-muted-foreground">
              <GitBranch className="h-6 w-6 opacity-40" />
              No agent branches yet. Start a task from the Assistant — each runs in its own worktree and branch.
            </div>
          ) : (
            <div className="space-y-5">
              {repos.map(([repo, ts]) => (
                <div key={repo} className="overflow-hidden rounded-xl border bg-card">
                  <div className="border-b px-4 py-3">
                    <span className="font-semibold">{repo}</span>
                  </div>
                  <div className="divide-y">
                    {ts.map((t) => {
                      const mergeFailed = t.status === "completed" && !t.merged;
                      const label = t.merged ? "merged" : mergeFailed ? "merge failed" : t.status.replace(/_/g, " ");
                      const badge = t.merged
                        ? STATUS_COLOR.completed
                        : mergeFailed
                          ? "border-red-500/40 text-red-500"
                          : STATUS_COLOR[t.status] ?? "border-border text-muted-foreground";
                      return (
                        <Link key={t.id} href={`/tasks/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                          {t.merged ? (
                            <GitMerge className="h-4 w-4 shrink-0 text-green-500" />
                          ) : (
                            <GitBranch className={cn("h-4 w-4 shrink-0", mergeFailed ? "text-red-500" : "text-amber-500")} />
                          )}
                          <code className="shrink-0 font-mono text-xs text-muted-foreground">bureau/task-{t.id.slice(0, 8)}</code>
                          <span className="min-w-0 flex-1 truncate text-sm">{t.goal}</span>
                          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium", badge)}>{label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
