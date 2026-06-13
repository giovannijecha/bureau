"use client";

import { useEffect, useState } from "react";
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
  CircleDashed,
  Circle,
  GitBranch,
} from "lucide-react";
import type { TaskDetail, PipelineStep } from "@bureau/contracts";
import { getTask, startTask, stopTask, mergeTask } from "../../../lib/api";
import { cn } from "../../../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
  created: "border-border text-muted-foreground",
  aborted: "border-red-500/40 text-red-500",
};

export default function TaskDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setTask(await getTask(id));
    } catch (e) {
      setError(errMsg(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
  const running = ["planning", "executing", "awaiting_human"].includes(task.status);

  return (
    <div className="h-full overflow-y-auto p-6">
      <Back />

      <div className="mt-4 mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{task.goal}</h1>
          <div className="mt-2 flex items-center gap-2.5 text-sm">
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
          {running && (
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

      {/* Pipeline */}
      <div className="mb-5 overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-4 py-3 text-sm font-semibold">Pipeline</div>
        <div className="divide-y">
          {task.steps.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3">
              <StepIcon status={s.status} />
              <span className="text-sm font-medium">{s.assignee}</span>
              <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{s.capability}</span>
              <span className="text-sm text-muted-foreground">{s.description}</span>
              <span className="ml-auto text-xs text-muted-foreground">{s.status.replace(/_/g, " ")}</span>
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
                Review the branch. Confirming squash-merges it into <code className="font-mono">main</code> and deletes the branch.
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
  if (status === "failed") return <AlertCircle className="h-4 w-4 text-red-500" />;
  if (status === "blocked_on_gate") return <CircleDot className="h-4 w-4 text-amber-500" />;
  if (status === "pending") return <Circle className="h-4 w-4 text-muted-foreground/50" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground/50" />;
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
