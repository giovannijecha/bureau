"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { GitBranch, GitMerge, GitCommit, ExternalLink, FolderGit2, Loader2, Trash2, Code2, History, GitFork, Wrench, GitPullRequest, CircleDot } from "lucide-react";
import type { TaskSummary, GitInfo, PullRequest, Issue } from "@bureau/contracts";
import { listTasks, getGitInfo, cleanupBranches, deleteBranch, getPrs, getIssues } from "../../lib/api";
import { useProjects } from "../../lib/useProjects";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { useConfirm } from "../../components/ConfirmDialog";
import { GitOpsPanel } from "../../components/GitOpsPanel";
import { GitCodeBrowser } from "../../components/GitCodeBrowser";
import { CommitDetailView } from "../../components/CommitDetailView";
import { cn } from "../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
};

type Tab = "code" | "commits" | "branches" | "prs" | "issues" | "operations";
const TABS: { id: Tab; label: string; icon: typeof Code2 }[] = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "commits", label: "Commits", icon: History },
  { id: "branches", label: "Branches", icon: GitFork },
  { id: "prs", label: "Pull requests", icon: GitPullRequest },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "operations", label: "Operations", icon: Wrench },
];

export default function GitPage() {
  const { active, activeId } = useProjects();
  const confirm = useConfirm();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitErr, setGitErr] = useState(false);
  const [tab, setTab] = useState<Tab>("code");
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      setTasks(await listTasks());
    } catch {
      setTasks([]);
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

  useEffect(() => void loadTasks(), [loadTasks]);
  useEffect(() => void loadGit(activeId ?? undefined), [activeId, loadGit]);
  // PRs/issues are loaded lazily (gh call) the first time their tab is opened.
  useEffect(() => {
    setPrs(null);
    setIssues(null);
  }, [activeId]);
  useEffect(() => {
    if (tab === "prs" && prs === null)
      getPrs(activeId ?? undefined)
        .then((p) => alive.current && setPrs(p))
        .catch(() => alive.current && setPrs([]));
    if (tab === "issues" && issues === null)
      getIssues(activeId ?? undefined)
        .then((i) => alive.current && setIssues(i))
        .catch(() => alive.current && setIssues([]));
  }, [tab, prs, issues, activeId]);
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
    if (t.status === "created" || t.status === "aborted") continue;
    const key = `${t.repoOwner}/${t.repoName}`;
    (byRepo.get(key) ?? byRepo.set(key, []).get(key)!).push(t);
  }
  const repos = [...byRepo.entries()];
  const repoSlug = active ? `${active.owner}/${active.name}` : git ? `${git.owner}/${git.name}` : "";

  return (
    <div className="h-full overflow-y-auto p-6">
      {selectedCommit && (
        <CommitDetailView projectId={activeId ?? undefined} hash={selectedCommit} repoSlug={repoSlug} onClose={() => setSelectedCommit(null)} />
      )}
      <div className="mx-auto max-w-5xl space-y-5">
        {/* Repo header */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FolderGit2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold">{repoSlug || "Repository"}</span>
              {git?.branch && (
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  <GitBranch className="h-3 w-3" /> {git.branch}
                </span>
              )}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {git?.cloned && (
              <button
                onClick={() => void cleanup()}
                disabled={cleaning}
                title="Delete leftover bureau/task-* branches"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {cleaning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Clean up branches
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
          <p className="flex items-center justify-center gap-2 rounded-xl border bg-card px-4 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the repository…
          </p>
        ) : gitErr || !git ? (
          <p className="rounded-xl border bg-card px-4 py-12 text-center text-sm text-muted-foreground">Couldn&apos;t read the repository.</p>
        ) : !git.cloned ? (
          <p className="rounded-xl border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
            Not cloned yet — start a task or chat with Iris and Bureau clones it on first use.
          </p>
        ) : (
          <>
            {/* Tab bar */}
            <div className="border-b">
              <nav className="-mb-px flex gap-1">
                {TABS.map((t) => {
                  const Icon = t.icon;
                  const on = tab === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={cn(
                        "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
                        on ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4" /> {t.label}
                      {t.id === "branches" && <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{git.branches.length}</span>}
                      {t.id === "commits" && <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{git.commits.length}</span>}
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Tab content */}
            {tab === "code" && (
              <GitCodeBrowser
                projectId={activeId ?? undefined}
                branches={git.branches}
                defaultBranch={git.branch ?? git.baseBranch}
                repoName={git.name}
                repoSlug={repoSlug}
              />
            )}

            {tab === "commits" && (
              <div className="overflow-hidden rounded-xl border bg-card">
                {git.commits.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-muted-foreground">No commits yet.</p>
                ) : (
                  <ul className="divide-y">
                    {git.commits.map((c) => (
                      <li key={c.hash} className="group/commit flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50">
                        <button onClick={() => setSelectedCommit(c.hash)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                          <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate text-sm">{c.subject}</span>
                          <code className="shrink-0 font-mono text-xs text-primary">{c.hash}</code>
                          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                            {c.author} · {c.date}
                          </span>
                        </button>
                        <a
                          href={`https://github.com/${repoSlug}/commit/${c.hash}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open on GitHub"
                          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover/commit:opacity-100"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {tab === "branches" && (
              <div className="overflow-hidden rounded-xl border bg-card">
                <ul className="divide-y">
                  {git.branches.map((b) => (
                    <li key={b} className="flex items-center gap-3 px-4 py-2.5">
                      <GitBranch className={cn("h-4 w-4 shrink-0", b === git.baseBranch ? "text-primary" : "text-muted-foreground")} />
                      <span className="min-w-0 flex-1 truncate text-sm">{b}</span>
                      {b === git.baseBranch && (
                        <span className="shrink-0 rounded-full border border-primary/40 px-2 py-0.5 text-[11px] font-medium text-primary">default</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tab === "prs" && (
              <PrIssueList
                loading={prs === null}
                rows={(prs ?? []).map((p) => ({ key: `pr${p.number}`, number: p.number, title: p.title, author: p.author, state: p.draft ? "draft" : p.state, url: p.url }))}
                empty="No pull requests."
              />
            )}

            {tab === "issues" && (
              <PrIssueList
                loading={issues === null}
                rows={(issues ?? []).map((i) => ({ key: `is${i.number}`, number: i.number, title: i.title, author: i.author, state: i.state, url: i.url }))}
                empty="No issues."
              />
            )}

            {tab === "operations" && (
              <GitOpsPanel branches={git.branches} projectId={activeId ?? undefined} onDone={() => void loadGit(activeId ?? undefined)} />
            )}
          </>
        )}

        {/* Agent branches — Bureau's task worktree branches (outside the tabs) */}
        <div>
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
            <GitBranch className="h-4 w-4 text-primary" /> Agent branches
          </h2>
          {cleanMsg && <p className="mb-2.5 text-xs text-muted-foreground">{cleanMsg}</p>}
          {tasks === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : repos.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-10 text-center text-sm text-muted-foreground">
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
                      // A merge only "failed" when one was attempted and errored — a read-only
                      // or no-diff task (research/plan/review) that simply completed has no
                      // mergeError and must NOT be flagged red.
                      const mergeFailed = t.mergeError !== null;
                      const inFlight = t.status === "planning" || t.status === "executing" || t.status === "awaiting_human";
                      const label = t.merged ? "merged" : t.prOpen ? "PR open" : mergeFailed ? "merge failed" : t.status.replace(/_/g, " ");
                      const badge = t.merged
                        ? STATUS_COLOR.completed
                        : t.prOpen
                          ? "border-blue-500/40 text-blue-400"
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
                              <GitBranch
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  mergeFailed ? "text-red-500" : inFlight ? "text-amber-500" : "text-muted-foreground"
                                )}
                              />
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

function PrIssueList({
  loading,
  rows,
  empty,
}: {
  loading: boolean;
  rows: { key: string; number: number; title: string; author: string; state: string; url: string }[];
  empty: string;
}) {
  if (loading)
    return (
      <p className="flex items-center justify-center gap-2 rounded-xl border bg-card px-4 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    );
  if (rows.length === 0) return <p className="rounded-xl border bg-card px-4 py-10 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.key}>
            <a href={r.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50">
              <StateBadge state={r.state} />
              <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">#{r.number}</span>
              {r.author && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{r.author}</span>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, string> = {
    open: "border-green-500/40 text-green-500",
    closed: "border-red-500/40 text-red-500",
    merged: "border-fuchsia-500/40 text-fuchsia-400",
    draft: "border-border text-muted-foreground",
  };
  return (
    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", map[state] ?? "border-border text-muted-foreground")}>
      {state}
    </span>
  );
}
