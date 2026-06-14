"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Play,
  Square,
  GitMerge,
  Loader2,
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Circle,
  GitBranch,
  XCircle,
} from "lucide-react";
import type { TaskDetail, PipelineStep } from "@bureau/contracts";
import { getTask, startTask, stopTask, mergeTask } from "../../../lib/api";
import { useEngineEvents } from "../../../lib/useEngineEvents";
import { cn } from "../../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
  created: "border-border text-muted-foreground",
  aborted: "border-red-500/40 text-red-500",
};

const RUNNING = new Set(["planning", "executing"]);

export default function TaskDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  // Live progress: reload whenever the engine pushes an event for this task.
  useEngineEvents((e) => {
    if ("taskId" in e && e.taskId === id) void load();
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

      {/* Pipeline */}
      <div className="mb-5 overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Pipeline</span>
          <span className="text-xs text-muted-foreground">{done}/{total} done</span>
        </div>
        <div className="divide-y">
          {task.steps.map((s, i) => (
            <div
              key={s.id}
              className={cn("flex items-center gap-3 px-4 py-3 transition-colors", s.status === "running" && "bg-primary/5")}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                {i + 1}
              </span>
              <StepIcon status={s.status} />
              <span className="text-sm font-medium">{s.assignee}</span>
              <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{s.capability}</span>
              <span className="truncate text-sm text-muted-foreground">{s.description}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.status.replace(/_/g, " ")}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Branch review + merge */}
      {(reviewable || task.status === "completed") && task.diff !== null && (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b px-4 py-3 text-sm font-semibold">Branch changes</div>
          <DiffView diff={task.diff} />
          {reviewable && (
            <div className="flex items-center justify-between gap-4 border-t bg-muted/40 px-4 py-3">
              <span className="text-sm text-muted-foreground">
                Confirming squash-merges into <code className="font-mono">main</code> and deletes the branch.
              </span>
              <button
                onClick={() => act(() => mergeTask(id))}
                disabled={busy}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-green-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
                Confirm &amp; merge to main
              </button>
            </div>
          )}
        </div>
      )}

      {task.prUrl && (
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

function StepIcon({ status }: { status: PipelineStep["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-red-500" />;
  if (status === "blocked_on_gate") return <CircleDot className="h-4 w-4 text-amber-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground/50" />;
}

function DiffView({ diff }: { diff: string }) {
  if (diff.trim() === "") return <pre className="px-4 py-6 text-center font-mono text-xs text-muted-foreground">(no changes)</pre>;
  const lines = diff.split("\n");
  return (
    <pre className="max-h-[460px] overflow-auto bg-black/40 px-4 py-3 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        const cls =
          line.startsWith("+") && !line.startsWith("+++")
            ? "text-green-400"
            : line.startsWith("-") && !line.startsWith("---")
              ? "text-red-400"
              : /^(@@|diff |index |\+\+\+|---)/.test(line)
                ? "text-muted-foreground"
                : "text-foreground/80";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
