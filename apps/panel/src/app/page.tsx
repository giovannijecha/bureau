"use client";

import { useRef, useState } from "react";
import {
  Sparkles,
  ArrowRight,
  FileText,
  BookOpen,
  Send,
  Loader2,
  GitBranch,
  CheckCircle2,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";
import type { TaskDetail, Message } from "@bureau/contracts";
import { sendMessage, decideGate, retryPr } from "../lib/api";
import { cn } from "../lib/utils";

const EXAMPLES: { title: string; icon: LucideIcon; prompt: string }[] = [
  { title: "Add an endpoint", icon: ArrowRight, prompt: "Add a GET /health endpoint that returns 200 OK." },
  { title: "Write a file", icon: FileText, prompt: "Add a CONTRIBUTING.md with a short contribution guide." },
  { title: "Improve the README", icon: BookOpen, prompt: "Add a Quick Start section to the README.md." },
];

const STATUS_COLOR: Record<string, string> = {
  awaiting_human: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  executing: "border-blue-500/40 text-blue-400",
  planning: "border-blue-500/40 text-blue-400",
  created: "border-border text-muted-foreground",
  aborted: "border-red-500/40 text-red-500",
};

export default function AssistantPage() {
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Message[]>([]);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function onSend() {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    setLog((l) => [...l, localUser(content)]);
    setInput("");
    try {
      const res = await sendMessage(content);
      setLog((l) => [...l, res.message]);
      setTask(res.task);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

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

  const openGate = task?.gates.find((g) => g.status === "open");
  const needsRetry = task?.status === "completed" && !task.prUrl;
  const empty = log.length === 0 && !task;

  return (
    <div className="flex h-full flex-col">
      {/* page header */}
      <div className="flex items-center gap-2.5 border-b px-6 py-4">
        <Sparkles className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-base font-semibold leading-none">Assistant</h1>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Describe a change — Iris prepares it in an isolated worktree and opens a PR on your approval.
          </p>
        </div>
      </div>

      {/* scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-8 px-6 py-10">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="h-6 w-6" />
              </div>
              <h2 className="text-xl font-semibold">What should Bureau build?</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Describe a change in plain language. Iris reads the repo, makes the edit, and shows you the diff before
                anything is pushed.
              </p>
            </div>
            <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              {EXAMPLES.map((ex) => {
                const Icon = ex.icon;
                return (
                  <button
                    key={ex.title}
                    onClick={() => {
                      setInput(ex.prompt);
                      inputRef.current?.focus();
                    }}
                    className="group flex flex-col gap-2.5 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent/50"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="text-sm font-semibold">{ex.title}</span>
                    <span className="text-xs leading-relaxed text-muted-foreground">{ex.prompt}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-6">
            {log.map((m) => (
              <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[82%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                    m.role === "user" ? "bg-primary text-primary-foreground" : "border bg-card"
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}

            {task && (
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                        STATUS_COLOR[task.status] ?? "border-border text-muted-foreground"
                      )}
                    >
                      {task.status.replace(/_/g, " ")}
                    </span>
                    <code className="font-mono text-xs text-muted-foreground">{task.id.slice(0, 8)}</code>
                  </div>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GitBranch className="h-3.5 w-3.5" />
                    {task.repoOwner}/{task.repoName}
                  </span>
                </div>

                {task.diff !== null && <DiffView diff={task.diff} />}

                {openGate && (
                  <div className="flex items-center justify-between gap-4 border-t bg-muted/40 px-4 py-3">
                    <span className="text-sm text-muted-foreground">
                      Review the diff. Approving commits, pushes, and opens the PR.
                    </span>
                    <div className="flex shrink-0 gap-2">
                      <button
                        disabled={busy}
                        onClick={() => act(() => decideGate(openGate.id, "approved"))}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-green-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        Approve &amp; open PR
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => act(() => decideGate(openGate.id, "rejected"))}
                        className="inline-flex h-9 items-center rounded-md border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                {needsRetry && (
                  <div className="flex items-center justify-between gap-4 border-t bg-muted/40 px-4 py-3">
                    <span className="text-sm text-muted-foreground">The branch was pushed but the PR didn&apos;t open.</span>
                    <button
                      disabled={busy}
                      onClick={() => act(() => retryPr(task.id))}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-green-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Retry PR
                    </button>
                  </div>
                )}

                {task.prUrl && (
                  <div className="flex items-center gap-2 border-t bg-green-500/5 px-4 py-3 text-sm text-green-500">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span className="text-foreground">PR opened —</span>
                    <a href={task.prUrl} target="_blank" rel="noreferrer" className="font-medium text-green-500 underline underline-offset-2">
                      {task.prUrl}
                    </a>
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </div>
        )}
      </div>

      {/* composer */}
      <div className="shrink-0 px-4 pb-4 pt-1">
        <div className="mx-auto w-full max-w-3xl rounded-xl border bg-card shadow-sm transition-colors focus-within:border-primary/60">
          <textarea
            ref={inputRef}
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={2}
            placeholder="Describe a change… (Enter to send, Shift+Enter for a new line)"
            className="min-h-[56px] w-full resize-none bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              {task ? `${task.repoOwner}/${task.repoName}` : "target repo"}
            </span>
            <button
              onClick={onSend}
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (diff.trim() === "") {
    return <pre className="px-4 py-6 text-center font-mono text-xs text-muted-foreground">(no changes)</pre>;
  }
  const lines = diff.split("\n");
  return (
    <pre className="max-h-[420px] overflow-auto bg-black/40 px-4 py-3 font-mono text-xs leading-relaxed">
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
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

function localUser(content: string): Message {
  return { id: `local-${content.length}-${hash(content)}`, role: "user", content, createdAt: "" };
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.abs((h * 31 + s.charCodeAt(i)) | 0);
  return h;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
