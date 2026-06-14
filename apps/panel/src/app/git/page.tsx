"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GitBranch, GitMerge, GitCommit, ExternalLink, FolderGit2, Loader2, Trash2 } from "lucide-react";
import type { TaskSummary, GitInfo } from "@bureau/contracts";
import { listTasks, getGitInfo, cleanupBranches, deleteBranch } from "../../lib/api";
import { useProjects } from "../../lib/useProjects";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { useConfirm } from "../../components/ConfirmDialog";
import { cn } from "../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
};

export default function GitPage() {
  const { active, activeId } = useProjects();
  const confirm = useConfirm();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitErr, setGitErr] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
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

  async function cleanup() {
    if (cleaning) return;
    const ok = await confirm({
      title: "Clean up leftover branches?",
      description: "Deletes bureau/task-* branches (local + remote) for finished tasks. Active tasks are kept; main and your own branches are never touched.",
      confirmLabel: "Clean up",
      variant: "destructive",
    });
    if (!ok) return;
    setCleaning(true);
    setCleanMsg(null);
    try {
      const res = await cleanupBranches(activeId ?? undefined);
      setCleanMsg(res.deleted.length ? `Removed ${res.deleted.length} branch${res.deleted.length === 1 ? "" : "es"}.` : "Nothing to clean up.");
      void loadGit(activeId ?? undefined);
    } catch {
      setCleanMsg("Cleanup failed.");
    } finally {
      setCleaning(false);
    }
  }

  async function removeBranch(t: TaskSummary) {
    const branch = `bureau/task-${t.id}`;
    const ok = await confirm({
      title: "Delete this branch?",
      description: `${branch} (local + remote) will be permanently deleted. This can't be undone — only Bureau's own task branches are deletable.`,
      confirmLabel: "Delete branch",
      variant: "destructive",
    });
    if (!ok) return;
    setDeleting(branch);
    setCleanMsg(null);
    try {
      const res = await deleteBranch(branch, activeId ?? undefined);
      setCleanMsg(res.deleted ? `Deleted ${branch}.` : `${branch} was already gone.`);
      void loadGit(activeId ?? undefined);
      void loadTasks();
    } catch (e) {
      setCleanMsg(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleting(null);
    }
  }

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
            <div className="flex shrink-0 items-center gap-3">
              {git?.cloned && (
                <button
                  onClick={() => void cleanup()}
                  disabled={cleaning}
                  title="Delete leftover bureau/task-* branches"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {cleaning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Clean up branches
                </button>
              )}
              {repoSlug && (
                <a
                  href={`https://github.com/${repoSlug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  GitHub <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
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
          {cleanMsg && <p className="mb-2.5 text-xs text-muted-foreground">{cleanMsg}</p>}
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
                      const inFlight = t.status === "planning" || t.status === "executing" || t.status === "awaiting_human";
                      const label = t.merged ? "merged" : mergeFailed ? "merge failed" : t.status.replace(/_/g, " ");
                      const badge = t.merged
                        ? STATUS_COLOR.completed
                        : mergeFailed
                          ? "border-red-500/40 text-red-500"
                          : STATUS_COLOR[t.status] ?? "border-border text-muted-foreground";
                      const branch = `bureau/task-${t.id}`;
                      return (
                        <div key={t.id} className="group/branch flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                          <Link href={`/tasks/${t.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                            {t.merged ? (
                              <GitMerge className="h-4 w-4 shrink-0 text-green-500" />
                            ) : (
                              <GitBranch className={cn("h-4 w-4 shrink-0", mergeFailed ? "text-red-500" : "text-amber-500")} />
                            )}
                            <code className="shrink-0 font-mono text-xs text-muted-foreground">bureau/task-{t.id.slice(0, 8)}</code>
                            <span className="min-w-0 flex-1 truncate text-sm">{t.goal}</span>
                          </Link>
                          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium", badge)}>{label}</span>
                          {!inFlight && (
                            <button
                              onClick={() => void removeBranch(t)}
                              disabled={deleting === branch}
                              title="Delete this branch (local + remote)"
                              aria-label="Delete branch"
                              className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-500 focus:opacity-100 group-hover/branch:opacity-100 disabled:opacity-50"
                            >
                              {deleting === branch ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                          )}
                        </div>
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
