"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Play,
  Square,
  GitMerge,
  GitPullRequest,
  Loader2,
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Circle,
  GitBranch,
  XCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Pencil,
  Send,
  Trash2,
  RotateCcw,
  Clock,
  Plus,
  Check,
} from "lucide-react";
import type { TaskDetail, PipelineStep, TimelineEntry } from "@bureau/contracts";
import { getTask, startTask, stopTask, resumeTask, discardTask, mergeTask, openPrForReview, mergeOpenPr, decideGate, deleteTask } from "../../../lib/api";
import { useEngineEvents } from "../../../lib/useEngineEvents";
import { useConfirm } from "../../../components/ConfirmDialog";
import { DiffView } from "../../../components/DiffView";
import { cn } from "../../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
  interrupted: "border-orange-500/40 text-orange-500",
  created: "border-border text-muted-foreground",
  aborted: "border-red-500/40 text-red-500",
};

const RUNNING = new Set(["planning", "executing"]);

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params); // Next 16: route params are async, unwrapped with React.use
  const router = useRouter();
  const confirm = useConfirm();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live worker output, accumulated per step from step_progress events.
  const [live, setLive] = useState<Record<string, string>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const t = await getTask(id);
      if (alive.current) setTask(t);
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live progress. A step_progress event streams the worker's output — accumulate
  // it into the live buffer (never reload, which would drop the stream). Every
  // other task event reloads the authoritative state.
  useEngineEvents((e) => {
    if (!("taskId" in e) || e.taskId !== id) return;
    if (e.type === "step_progress") {
      setLive((prev) => ({ ...prev, [e.stepId]: (prev[e.stepId] ?? "") + e.chunk }));
      return;
    }
    // A step (re)starting begins a fresh stream — drop its stale buffer so a
    // request-changes re-run doesn't glue the first run's output onto the new one.
    if (e.type === "step_started") {
      setLive((prev) => {
        const next = { ...prev };
        delete next[e.stepId];
        return next;
      });
    }
    void load();
  });

  async function act(fn: () => Promise<TaskDetail>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setTask(await fn());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || !task) return;
    const live = RUNNING.has(task.status) || task.status === "awaiting_human";
    const ok = await confirm({
      title: "Delete this task?",
      description: live
        ? "It's still live — deleting will stop it (tearing down its worktree) and remove it permanently. This can't be undone."
        : "The task and its history will be permanently removed. This can't be undone. (Its branch, if any, is kept — use Git → Clean up branches.)",
      confirmLabel: "Delete task",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteTask(id);
      router.push("/tasks");
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  async function discard() {
    if (busy) return;
    const ok = await confirm({
      title: "Discard this task?",
      description: "Aborts it and removes its worktree — the interrupted work is lost. Resume re-runs it clean from base instead.",
      confirmLabel: "Discard",
      variant: "destructive",
    });
    if (!ok) return;
    await act(() => discardTask(id));
  }

  if (!task) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <Back />
        <p className="mt-6 text-sm text-muted-foreground">{error ? `⚠ ${error}` : "Loading…"}</p>
      </div>
    );
  }

  const reviewable = task.status === "awaiting_human";
  const running = RUNNING.has(task.status);
  const stoppable = running || reviewable;
  const total = task.steps.length;
  const done = task.steps.filter((s) => s.status === "completed" || s.status === "blocked_on_gate").length;
  const active = task.steps.find((s) => s.status === "running");

  return (
    <div className="h-full overflow-y-auto p-6">
      <Back />

      <div className="mt-4 mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{task.goal}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm">
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_COLOR[task.status])}>
              {task.status.replace(/_/g, " ")}
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              {task.repoOwner}/{task.repoName}
            </span>
            <code className="font-mono text-xs text-muted-foreground">{task.id.slice(0, 8)}</code>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {task.status === "created" && (
            <button
              onClick={() => act(() => startTask(id))}
              disabled={busy}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Start
            </button>
          )}
          {stoppable && (
            <button
              onClick={() => act(() => stopTask(id))}
              disabled={busy}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              <Square className="h-4 w-4" />
              Stop
            </button>
          )}
          {task.status === "interrupted" && (
            <>
              <button
                onClick={() => act(() => resumeTask(id))}
                disabled={busy}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                Resume
              </button>
              <button
                onClick={() => void discard()}
                disabled={busy}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Discard
              </button>
            </>
          )}
          <button
            onClick={() => void remove()}
            disabled={busy}
            title="Delete this task"
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Running banner — reassure the CEO they can step away. */}
      {running && (
        <div className="mb-5 rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-2.5">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm font-medium">
              {task.status === "planning"
                ? "Setting up an isolated workspace…"
                : active
                  ? `${active.assignee} is working — ${active.description}`
                  : "Working…"}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              {done}/{total} steps
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${total ? Math.round((done / total) * 100) : 5}%` }}
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Iris runs this in the background. You can leave this page or close the panel — it keeps going, and you&apos;ll
            find it ready for review here when it&apos;s done.
          </p>
        </div>
      )}

      {/* Awaiting review banner */}
      {reviewable && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-foreground">
            The pipeline finished and the branch is ready. Review the changes below, then confirm to squash-merge into{" "}
            <code className="font-mono text-xs">main</code> — or Stop to discard it.
          </p>
        </div>
      )}

      {/* Aborted banner */}
      {task.status === "aborted" && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <p className="text-sm text-foreground">
            This task stopped before finishing.{task.statusNote ? <> {task.statusNote}</> : null}
          </p>
        </div>
      )}

      {/* Interrupted banner — the engine restarted mid-run; the CEO chooses Resume or Discard. */}
      {task.status === "interrupted" && (
        <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-orange-500/30 bg-orange-500/5 p-4">
          <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
          <p className="text-sm text-foreground">
            The engine restarted while this task was running, so it was paused — its work was kept. <strong>Resume</strong> re-runs
            the whole pipeline cleanly from base (no half-finished edits); <strong>Discard</strong> drops it.
          </p>
        </div>
      )}

      {/* Pipeline */}
      <div className="mb-5 overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Pipeline</span>
          <span className="text-xs text-muted-foreground">{done}/{total} done</span>
        </div>
        <div className="divide-y">
          {task.steps.map((s, i) => (
            <div key={s.id} className={cn("px-4 py-3 transition-colors", s.status === "running" && "bg-primary/5")}>
              <div className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <StepIcon status={s.status} />
                <span className="text-sm font-medium">{s.assignee}</span>
                <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{s.capability}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{s.description}</span>
                <StepDuration step={s} />
                <span className="shrink-0 text-xs text-muted-foreground">{s.status.replace(/_/g, " ")}</span>
              </div>
              {s.failureReason && (
                <p className="ml-9 mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-xs text-red-400">
                  {s.failureReason}
                </p>
              )}
              <WorkerOutput status={s.status} summary={s.summary} live={live[s.id]} capability={s.capability} />
            </div>
          ))}
        </div>
      </div>

      {/* Timeline — the full history: substeps, gates, and request-changes cycles. */}
      {task.timeline.length > 0 && <Timeline entries={task.timeline} />}

      {/* Branch review + merge */}
      {(reviewable || task.status === "completed") && task.diff !== null && (
        <div className="mt-5 overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3 text-sm font-semibold">Branch changes</div>
          <DiffView diff={task.diff} />
          {reviewable && <ReviewBar id={id} busy={busy} act={act} />}
          {task.prOpen && <PrOpenBar id={id} prUrl={task.prUrl} mergeError={task.mergeError} busy={busy} act={act} />}
        </div>
      )}

      {/* Merge failed — the CEO confirmed but it couldn't land. Honest, with the
          PR link (if one was opened) so they can resolve it on GitHub. */}
      {/* A genuinely failed merge (NOT a still-open PR — that case shows the retry in
          PrOpenBar above). Honest "nothing landed" with the PR link. */}
      {task.mergeError && !task.prOpen && (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <div className="space-y-1">
            <p className="text-foreground">The merge didn&apos;t complete — nothing landed on <code className="font-mono text-xs">main</code>.</p>
            <p className="text-xs text-red-400">{task.mergeError}</p>
            {task.prUrl && (
              <a href={task.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2">
                Open the PR on GitHub <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      )}

      {task.merged && task.prUrl && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border bg-green-500/5 px-4 py-3 text-sm text-green-500">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="text-foreground">Merged to main —</span>
          <a href={task.prUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
            {task.prUrl}
          </a>
        </div>
      )}

    </div>
  );
}

function Back() {
  return (
    <Link href="/tasks" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft className="h-4 w-4" />
      Tasks
    </Link>
  );
}

/** The worker's report — live stream while it works, persisted summary once done. */
function WorkerOutput({
  status,
  summary,
  live,
  capability,
}: {
  status: PipelineStep["status"];
  summary: string | null;
  live: string | undefined;
  capability: PipelineStep["capability"];
}) {
  // While running, show the live stream. Once terminal, show ONLY the persisted
  // summary — never the partial pre-failure stream, which would masquerade as a
  // deliberate report under the red failure reason.
  const streaming = status === "running";
  const text = streaming ? live : summary;
  if (!text) {
    if (streaming) {
      return (
        <p className="ml-9 mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Working…
        </p>
      );
    }
    return null;
  }
  if (streaming) {
    return (
      <pre className="ml-9 mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-primary/20 bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-300">
        {text}
        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary align-middle" />
      </pre>
    );
  }
  // ONLY a test step's verdict gets the green/red treatment (keyed on capability so
  // another worker's summary that happens to start with ✓/✗ never mis-renders).
  const passed = capability === "test" && text.startsWith("✓");
  const failed = capability === "test" && (text.startsWith("✗") || text.startsWith("⚠"));
  return (
    <pre
      className={cn(
        "ml-9 mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border px-2.5 py-1.5 text-xs",
        failed ? "border-red-500/30 bg-red-500/5 text-red-400" : passed ? "border-green-500/30 bg-green-500/5 text-green-500" : "bg-muted/40 text-muted-foreground"
      )}
    >
      {!passed && !failed && <span className="font-medium text-foreground/70">Reported: </span>}
      {text}
    </pre>
  );
}

/** The review decision bar — approve & merge, request changes (re-run with notes),
 *  or reject (abort). request_changes flips the task to executing → the running
 *  banner + live stream take over with no extra wiring. */
/** Footer for a prOpen task (branch pushed + PR opened, not merged): the PR link + a
 *  "Merge to main" action, co-located with the diff — and a retry when a merge failed. */
function PrOpenBar({
  id,
  prUrl,
  mergeError,
  busy,
  act,
}: {
  id: string;
  prUrl: string | null;
  mergeError: string | null;
  busy: boolean;
  act: (fn: () => Promise<TaskDetail>) => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-t border-blue-500/20 bg-blue-500/5 px-4 py-3.5">
      <div className="min-w-0 flex-1 space-y-1 text-sm">
        <p className="flex items-center gap-1.5 text-foreground">
          <GitPullRequest className="h-4 w-4 shrink-0 text-blue-400" /> PR open for review — not merged. Approve the diff above, then merge to main.
        </p>
        {prUrl && (
          <a href={prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-xs font-medium text-blue-400 underline underline-offset-2">
            {prUrl} <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        )}
        {mergeError && (
          <p className="flex items-start gap-1.5 text-xs text-red-400">
            <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> Last merge attempt failed — the PR is still open, you can retry. ({mergeError})
          </p>
        )}
      </div>
      <button
        onClick={() => act(() => mergeOpenPr(id))}
        disabled={busy}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-green-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
        {mergeError ? "Retry merge" : "Merge to main"}
      </button>
    </div>
  );
}

function ReviewBar({ id, busy, act }: { id: string; busy: boolean; act: (fn: () => Promise<TaskDetail>) => void }) {
  const confirm = useConfirm();
  const [requesting, setRequesting] = useState(false);
  const [pending, setPending] = useState<null | "merge" | "pr">(null);
  const [notes, setNotes] = useState("");
  const trimmed = notes.trim();

  if (requesting) {
    return (
      <div className="space-y-2 border-t bg-muted/40 px-4 py-3">
        <label className="text-sm font-medium">What should change?</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          autoFocus
          placeholder="Describe the changes you want — the worker will revise the diff and bring it back for review."
          className="w-full resize-y rounded-md border bg-background p-2.5 text-sm outline-none focus:border-primary"
        />
        {trimmed === "" && <p className="text-xs text-muted-foreground">Add your feedback below to send the request.</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => {
              setRequesting(false);
              setNotes("");
            }}
            className="inline-flex h-9 items-center rounded-md border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={() => act(() => decideGate(id, "request_changes", trimmed))}
            disabled={busy || trimmed === ""}
            title={trimmed === "" ? "Add your feedback to send" : undefined}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-amber-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send request
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t bg-muted/40 px-4 py-3.5">
      <p className="text-sm font-medium text-foreground">Happy with the changes? Choose how to land them:</p>
      {/* The two "approve" outcomes as distinct, labelled choices — so it's clear which
          does what (a git novice shouldn't have to guess between two similar buttons). */}
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          onClick={() => {
            setPending("merge");
            act(() => decideGate(id, "approved"));
          }}
          disabled={busy}
          className="flex items-start gap-2.5 rounded-lg border border-green-600/50 bg-green-600/10 p-3 text-left transition-colors hover:bg-green-600/15 disabled:opacity-50"
        >
          {pending === "merge" && busy ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-green-500" />
          ) : (
            <GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
          )}
          <span>
            <span className="block text-sm font-semibold text-foreground">Merge into main</span>
            <span className="block text-xs text-muted-foreground">Apply the changes to your main branch now. The usual choice.</span>
          </span>
        </button>
        <button
          onClick={() => {
            setPending("pr");
            act(() => openPrForReview(id));
          }}
          disabled={busy}
          className="flex items-start gap-2.5 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3 text-left transition-colors hover:bg-blue-500/10 disabled:opacity-50"
        >
          {pending === "pr" && busy ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-400" />
          ) : (
            <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
          )}
          <span>
            <span className="block text-sm font-semibold text-foreground">Open a PR instead</span>
            <span className="block text-xs text-muted-foreground">Put it on GitHub on its own branch — you review and merge it there. Nothing touches main yet.</span>
          </span>
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setRequesting(true)}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5" />
          Request changes
        </button>
        <button
          onClick={async () => {
            const ok = await confirm({
              title: "Reject this task?",
              description: "The task will be aborted and its branch discarded. This can't be undone.",
              confirmLabel: "Reject task",
              variant: "destructive",
            });
            if (!ok) return;
            act(() => decideGate(id, "rejected"));
          }}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" />
          Reject
        </button>
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: PipelineStep["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-red-500" />;
  if (status === "blocked_on_gate") return <CircleDot className="h-4 w-4 text-amber-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground/50" />;
}

/** How long a step took (or has been running) — from its start/finish timestamps.
 *  A running step self-ticks every second and is tinted/suffixed so a live elapsed
 *  never reads as a final duration. */
function StepDuration({ step }: { step: PipelineStep }) {
  const running = step.status === "running";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!step.startedAt) return null;
  const start = Date.parse(step.startedAt);
  if (Number.isNaN(start)) return null;
  const end = step.completedAt ? Date.parse(step.completedAt) : Date.now();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  return (
    <span
      className={cn("hidden shrink-0 items-center gap-1 text-[11px] sm:inline-flex", running ? "text-blue-400" : "text-muted-foreground")}
      title={step.startedAt}
    >
      <Clock className="h-3 w-3" />
      {fmtDuration(secs)}
      {running ? "…" : ""}
    </span>
  );
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const TIMELINE_ICON: Record<string, { icon: typeof Circle; tint: string }> = {
  task_created: { icon: Plus, tint: "text-muted-foreground" },
  step_started: { icon: Play, tint: "text-blue-400" },
  step_completed: { icon: CheckCircle2, tint: "text-green-500" },
  step_failed: { icon: XCircle, tint: "text-red-500" },
  gate_opened: { icon: CircleDot, tint: "text-amber-500" },
  gate_reopened: { icon: Pencil, tint: "text-amber-500" },
  gate_decided: { icon: Check, tint: "text-green-500" },
  // Completion ≠ merge; the label says which it was. Use a neutral done-check glyph.
  task_completed: { icon: CheckCircle2, tint: "text-green-500" },
  task_aborted: { icon: XCircle, tint: "text-red-500" },
};

/** The full event history — substeps, gates, and request-changes cycles — as a
 *  vertical timeline. Each gate_reopened is one revision cycle. */
function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const [open, setOpen] = useState(true);
  const cycles = entries.filter((e) => e.type === "gate_reopened").length;
  return (
    <div className="mb-5 overflow-hidden rounded-xl border bg-card">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between border-b px-4 py-3 text-left transition-colors hover:bg-muted/30">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
          Timeline
        </span>
        <span className="text-xs text-muted-foreground">
          {entries.length} event{entries.length === 1 ? "" : "s"}
          {cycles > 0 ? ` · ${cycles} revision${cycles === 1 ? "" : "s"}` : ""}
        </span>
      </button>
      {open && (
        <ol className="px-4 py-2">
          {entries.map((e, i) => {
            const meta = TIMELINE_ICON[e.type] ?? { icon: Circle, tint: "text-muted-foreground" };
            const Icon = meta.icon;
            const last = i === entries.length - 1;
            return (
              <li key={i} className="flex items-stretch gap-3">
                {/* connector rail + node */}
                <div className="flex w-4 shrink-0 flex-col items-center">
                  <Icon className={cn("mt-1.5 h-4 w-4 shrink-0", meta.tint)} />
                  {!last && <span className="my-0.5 w-px flex-1 bg-border" />}
                </div>
                <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate text-sm">{e.label}</span>
                  <time className="shrink-0 text-xs tabular-nums text-muted-foreground" title={e.at}>
                    {absTime(e.at)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Local wall-clock time (HH:MM:SS) for a timeline row — client-only, no SSR risk. */
function absTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
