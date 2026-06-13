"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  Sparkles,
  Send,
  Loader2,
  AlertCircle,
  Workflow,
  Pencil,
  MessageSquare,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import type { Message, TaskProposal } from "@bureau/contracts";
import { chat, createTask } from "../lib/api";
import { cn } from "../lib/utils";

const ASSIGNEE: Record<string, string> = {
  plan: "Planner",
  edit: "Editor",
  test: "Tester",
  review: "Reviewer",
  document: "Scribe",
};

export default function AssistantPage() {
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<TaskProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function onSend() {
    const content = input.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    setProposal(null);
    setLog((l) => [...l, local("user", content)]);
    setInput("");
    try {
      const res = await chat(content);
      setLog((l) => [...l, res.reply]);
      if (res.proposal) setProposal(res.proposal);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  function refine() {
    setProposal(null);
    setInput("Let's refine that: ");
    inputRef.current?.focus();
  }

  async function create() {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createTask(proposal);
      setProposal(null);
      setLog((l) => [...l, createdNote(task.id, proposal.title)]);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const empty = log.length === 0 && !proposal;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b px-6 py-4">
        <Sparkles className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-base font-semibold leading-none">Assistant</h1>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Talk with Iris. When you&apos;re aligned, she proposes a task you can create and run.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Sparkles className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-semibold">Let&apos;s figure out what to build</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Tell Iris what you need or where you are. She&apos;ll talk it through and, when it&apos;s clear, propose a
              task — a pipeline you can create, review, and run.
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-6">
            {log.map((m) => (
              <ChatBubble key={m.id} message={m} />
            ))}
            {proposal && <ProposalCard proposal={proposal} busy={busy} onCreate={create} onRefine={refine} onKeep={() => setProposal(null)} />}
            {error && (
              <div className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </div>
        )}
      </div>

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
            placeholder="Talk to Iris… (Enter to send, Shift+Enter for a new line)"
            className="min-h-[56px] w-full resize-none bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-end px-2 pb-2">
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

function ChatBubble({ message }: { message: Message }) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <Link
          href={message.taskId ? `/tasks/${message.taskId}` : "/tasks"}
          className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50"
        >
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          {message.content}
        </Link>
      </div>
    );
  }
  return (
    <div className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[82%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          message.role === "user" ? "bg-primary text-primary-foreground" : "border bg-card"
        )}
      >
        {message.content}
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  busy,
  onCreate,
  onRefine,
  onKeep,
}: {
  proposal: TaskProposal;
  busy: boolean;
  onCreate: () => void;
  onRefine: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="rounded-xl border border-primary/30 bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <Workflow className="h-4 w-4 text-primary" />
        <span className="font-semibold">{proposal.title}</span>
        <span className="ml-auto rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
          Proposed task
        </span>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{proposal.summary}</p>
      <div className="mb-4 space-y-1.5">
        {proposal.steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2.5 text-sm">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">
              {i + 1}
            </span>
            <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
              {ASSIGNEE[s.capability] ?? s.capability}
            </span>
            <span>{s.description}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onCreate}
          disabled={busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          Create task
        </button>
        <button
          onClick={onRefine}
          disabled={busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Pencil className="h-4 w-4" />
          Refine
        </button>
        <button
          onClick={onKeep}
          disabled={busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <MessageSquare className="h-4 w-4" />
          Keep chatting
        </button>
      </div>
    </div>
  );
}

function local(role: "user" | "iris", content: string): Message {
  return { id: `local-${role}-${Math.abs(hash(content))}`, role, content, createdAt: "" };
}
function createdNote(taskId: string, title: string): Message {
  return { id: `created-${taskId}`, role: "system", content: `Created “${title}” — open it in Tasks`, taskId, createdAt: "" };
}
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
