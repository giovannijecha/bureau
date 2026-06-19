"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
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
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
  Coins,
  FolderGit2,
  Plus,
} from "lucide-react";
import type { Message, TaskProposal, Conversation, Attachment, GitOpRequest, CostEstimate } from "@bureau/contracts";
import { chat, createTask, estimateCost, getConfig, listConversations, deleteConversation, messagesFor, getGitInfo, ENGINE_URL } from "../lib/api";
import { useProjects } from "../lib/useProjects";
import { useEngineEvents } from "../lib/useEngineEvents";
import { useToast } from "../components/Toast";
import { useSettingsModal } from "../components/SettingsModal";
import { ProjectSwitcher } from "../components/ProjectSwitcher";
import { ConversationsRail } from "../components/ConversationsRail";
import { GitOpProposalCard } from "../components/GitOpProposalCard";
import { RunCommand, type RunResult } from "../components/RunCommand";
import { Markdown } from "../components/Markdown";
import { FieldError } from "../components/FieldError";
import { CharCount } from "../components/CharCount";
import { useConfirm } from "../components/ConfirmDialog";
import { cn } from "../lib/utils";

const MESSAGE_MAX = 32_000; // mirrors SendMessageRequestDto.content.max(32_000)

const ASSIGNEE: Record<string, string> = {
  plan: "Planner",
  research: "Researcher",
  edit: "Editor",
  test: "Tester",
  review: "Reviewer",
  document: "Scribe",
};

export default function AssistantPage() {
  const { projects, active, activeId, setActiveId, loading: projectsLoading, error: projectsError, refresh: refreshProjects } = useProjects();
  const confirm = useConfirm();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const { open: openSettings } = useSettingsModal();
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<TaskProposal | null>(null);
  const [gitOp, setGitOp] = useState<GitOpRequest | null>(null);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  // Commands the CEO confirmed (clicked "Run" on, in Iris's reply) — run inline, output
  // shown right here in the chat. Persisted per-conversation so finished runs survive a
  // reload / thread switch (rehydrated as a static transcript, never re-executed).
  const [runs, setRuns] = useState<{ id: number; command: string; result?: RunResult }[]>([]);
  const runSeq = useRef(0);
  const runInChat = useCallback((command: string) => {
    setRuns((r) => [...r, { id: ++runSeq.current, command }]);
  }, []);
  const [busy, setBusy] = useState(false);
  // The latest live "what Iris is doing" line (a tool she just invoked), shown while a
  // reply is pending. Streamed over the WS as the chat HTTP request is in flight.
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [composerErr, setComposerErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Live "what Iris is doing" — the engine streams a line per tool she invokes during the
  // turn. Only rendered while a reply is pending; reset on each send and on completion.
  useEngineEvents((e) => {
    if (e.type === "iris_activity") setActivity(e.summary);
  });

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      /* engine offline — leave as-is */
    }
  }, []);

  const selectConv = useCallback(async (id: string) => {
    setConvId(id);
    setProposal(loadProposal(id)); // restore a pending proposal for this thread
    setGitOp(loadGitOp(id)); // …and a pending git-op proposal
    const savedRuns = loadRuns(id); // rehydrate finished command transcripts (static)
    setRuns(savedRuns);
    runSeq.current = savedRuns.reduce((m, r) => Math.max(m, r.id), runSeq.current); // avoid id collisions
    setError(null);
    try {
      // Re-attach the local action confirmations ("Created …" / git-op results) — the
      // engine doesn't persist them, so without this they'd vanish on every reload/switch.
      // Merge-sort by timestamp so each chip lands back in its chronological slot rather
      // than all piling up at the bottom.
      setLog(mergeByTime(await messagesFor(id), loadNotes(id)));
    } catch {
      setLog(loadNotes(id));
    }
  }, []);

  const newChat = useCallback(() => {
    setConvId(null);
    setLog([]);
    setProposal(null);
    setGitOp(null);
    setRuns([]);
    setError(null);
    inputRef.current?.focus();
  }, []);

  // A note's "Ask Iris" deep-link (?ask=) pre-fills the composer.
  useEffect(() => {
    const ask = new URLSearchParams(window.location.search).get("ask");
    if (ask) {
      setInput(ask);
      window.history.replaceState(null, "", window.location.pathname);
      inputRef.current?.focus();
    }
  }, []);

  // Load threads on mount; open the most recent one.
  useEffect(() => {
    let alive = true;
    listConversations()
      .then((cs) => {
        if (!alive) return;
        setConversations(cs);
        if (cs.length > 0) void selectConv(cs[0]!.id);
      })
      .catch(() => {});
    return () => void (alive = false);
  }, [selectConv]);

  // Keep the newest message in view as the log grows or Iris is replying.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log, busy, proposal, gitOp, runs]);

  // When Iris proposes a git-op, fetch the repo's branches once so the card can offer
  // a branch autocomplete (lazy — only on the first proposal, never on a plain chat).
  useEffect(() => {
    if (gitOp && gitBranches.length === 0) {
      getGitInfo(activeId ?? undefined)
        .then((g) => setGitBranches(g.branches))
        .catch(() => {});
    }
  }, [gitOp, gitBranches.length, activeId]);

  async function onSend() {
    const content = input.trim();
    if (busy) return;
    if (input.length > MESSAGE_MAX) {
      setComposerErr(`Message is too long — keep it under ${MESSAGE_MAX.toLocaleString()} characters.`);
      return;
    }
    if (!content && attachments.length === 0) return;
    setBusy(true);
    setActivity(null); // fresh turn — drop any prior activity line
    setError(null);
    setComposerErr(null);
    setProposal(null);
    setGitOp(null);
    persistProposal(convId, null); // clear up-front so a failed send can't resurrect the old proposal
    persistGitOp(convId, null);
    const atts = attachments;
    const shown = content + (atts.length ? `${content ? "\n\n" : ""}📎 ${atts.map((a) => a.name).join(", ")}` : "");
    setLog((l) => [...l, local("user", shown)]);
    setInput("");
    setAttachments([]);
    try {
      const res = await chat(content, activeId ?? undefined, convId ?? undefined, atts.length ? atts : undefined);
      setLog((l) => [...l, res.reply]);
      setConvId(res.conversationId); // always adopt the server's authoritative thread id
      // Persist (or clear) the proposal/git-op for this thread so it survives reload / switch.
      setProposal(res.proposal ?? null);
      persistProposal(res.conversationId, res.proposal ?? null);
      setGitOp(res.gitOp ?? null);
      persistGitOp(res.conversationId, res.gitOp ?? null);
      if (res.notice) toastInfo("Heads-up", res.notice); // e.g. thread compacted — consider New chat
      void refreshConversations();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file
    const room = 8 - attachments.length;
    if (room <= 0) {
      setComposerErr("You can attach up to 8 files — remove one to add another.");
      return;
    }
    let msg: string | null = null;
    const next: Attachment[] = [];
    for (const file of files.slice(0, room)) {
      try {
        if (file.type.startsWith("image/")) {
          if (file.size > 8_000_000) {
            msg = `“${file.name}” is too large (max 8 MB for an image).`;
            continue;
          }
          const dataUrl = await readFile(file, "dataURL");
          next.push({ name: file.name, kind: "image", content: dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl, mediaType: file.type || "image/png" });
        } else {
          if (file.size > 256_000) {
            msg = `“${file.name}” is too large (max 256 KB for a text file).`;
            continue;
          }
          next.push({ name: file.name, kind: "text", content: await readFile(file, "text") });
        }
      } catch {
        msg = `Couldn’t read “${file.name}”.`;
      }
    }
    if (!msg && files.length > room) msg = `Added the first ${room} — you can attach up to 8 files.`;
    setComposerErr(msg);
    if (next.length) setAttachments((a) => [...a, ...next]);
  }

  async function removeConv(id: string) {
    const ok = await confirm({
      title: "Delete conversation?",
      description: "This conversation and all its messages will be permanently removed. This can't be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await deleteConversation(id);
    } catch {
      /* ignore */
    }
    clearNotes(id); // drop the thread's persisted action chips + pending proposals
    clearRuns(id);
    persistProposal(id, null);
    persistGitOp(id, null);
    await refreshConversations();
    if (id === convId) newChat();
  }

  function refine() {
    setProposal(null);
    persistProposal(convId, null);
    setInput("Let's refine that: ");
    inputRef.current?.focus();
  }

  async function create() {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createTask(proposal, activeId ?? undefined);
      const title = proposal.title;
      setProposal(null);
      persistProposal(convId, null);
      const note = createdNote(task.id, title);
      setLog((l) => [...l, note]);
      appendNote(convId, note); // survive reload / conversation-switch
      toastSuccess("Task created", `“${title}” — open it in Tasks to start it.`);
    } catch (e) {
      setError(errMsg(e));
      toastError("Couldn’t create the task", errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const empty = log.length === 0 && !proposal && !gitOp && runs.length === 0;

  // With no project to scope Iris to, show one of two distinct states (never the dead
  // Assistant). Gated on `!projectsLoading` so neither flashes during the initial fetch.
  if (!projectsLoading && projects.length === 0) {
    // A fetch error means the engine is unreachable — say so (and how to recover) rather
    // than wrongly telling a newcomer with a downed engine to "add a repository".
    return projectsError ? (
      <EngineOffline message={projectsError} onRetry={refreshProjects} />
    ) : (
      <NoProjectsOnboarding onAdd={() => openSettings("projects")} />
    );
  }

  return (
    <div className="flex h-full">
      <ConversationsRail conversations={conversations} activeId={convId} onSelect={selectConv} onNew={newChat} onDelete={removeConv} />

      <div className="flex min-w-0 flex-1 flex-col">
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
            <div className="w-full space-y-3.5 px-6 py-6 lg:px-10">
              {log.map((m) => (
                <ChatBubble key={m.id} message={m} onRun={runInChat} />
              ))}
              {busy && <TypingIndicator activity={activity} />}
              {proposal && (
                <ProposalCard
                  proposal={proposal}
                  busy={busy}
                  onCreate={create}
                  onRefine={refine}
                  onKeep={() => {
                    setProposal(null);
                    persistProposal(convId, null);
                  }}
                />
              )}
              {gitOp && (
                <GitOpProposalCard
                  gitOp={gitOp}
                  branches={gitBranches}
                  projectId={activeId ?? undefined}
                  onRan={(text) => {
                    setGitOp(null);
                    persistGitOp(convId, null);
                    const note = opNote(text);
                    setLog((l) => [...l, note]);
                    appendNote(convId, note); // survive reload / conversation-switch
                  }}
                  onDismiss={() => {
                    setGitOp(null);
                    persistGitOp(convId, null);
                  }}
                />
              )}
              {runs.map((r) => (
                <div key={r.id} className="flex justify-start">
                  <div className="w-full max-w-[92%] sm:max-w-[85%]">
                    <RunCommand
                      command={r.command}
                      projectId={activeId ?? undefined}
                      {...(r.result ? { initial: r.result } : {})}
                      onComplete={(result) => appendRun(convId, { id: r.id, command: r.command, result })}
                      onDismiss={() => {
                        setRuns((rs) => rs.filter((x) => x.id !== r.id));
                        removeRun(convId, r.id);
                      }}
                    />
                  </div>
                </div>
              ))}
              {error && (
                <div className="flex items-center gap-1.5 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="shrink-0 px-6 pb-4 pt-2 lg:px-10">
          <div className="w-full rounded-2xl border bg-card shadow-sm transition-all focus-within:border-primary/50 focus-within:shadow-md focus-within:ring-1 focus-within:ring-primary/15">
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
              rows={1}
              placeholder="Message Iris…"
              className="max-h-44 min-h-[48px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
            />
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pb-0.5 pt-1">
                {attachments.map((a, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs">
                    {a.kind === "image" ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-primary" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
                    <span className="max-w-[160px] truncate">{a.name}</span>
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={`Remove ${a.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                  title="Attach images or files"
                  aria-label="Attach"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept="image/*,.md,.markdown,.txt,.json,.csv,.log,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.rb,.php,.c,.cpp,.h,.css,.html,.yml,.yaml,.toml,.sh,.sql,text/*"
                  className="hidden"
                  onChange={onFiles}
                />
                {/* The global header switcher owns project scope on md+; keep a fallback
                    here only on narrow screens where that switcher is hidden. */}
                <div className="md:hidden">
                  <ProjectSwitcher compact projects={projects} active={active} onChange={setActiveId} />
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <CharCount value={input.length} max={MESSAGE_MAX} />
                <button
                  onClick={onSend}
                  disabled={busy || input.length > MESSAGE_MAX || (!input.trim() && attachments.length === 0)}
                  aria-label="Send"
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <div className="px-1">
            <FieldError message={composerErr} />
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Iris proposes tasks — you decide. <kbd className="rounded border px-1 py-px font-sans text-[10px]">Enter</kbd> to send ·{" "}
            <kbd className="rounded border px-1 py-px font-sans text-[10px]">Shift</kbd>+
            <kbd className="rounded border px-1 py-px font-sans text-[10px]">Enter</kbd> for a new line
          </p>
        </div>
      </div>
    </div>
  );
}

function NoProjectsOnboarding({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <FolderGit2 className="h-7 w-7" />
      </div>
      <h2 className="text-xl font-semibold">Welcome to Bureau</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Add one of your GitHub repositories to get started. Iris will scope her work to it — turning what you ask
        into reviewed pull requests you approve. You stay the CEO.
      </p>
      <button
        onClick={onAdd}
        className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <Plus className="h-4 w-4" /> Add your first repository
      </button>
      <p className="max-w-md text-xs text-muted-foreground/70">
        Bureau runs entirely on your machine. Nothing reaches GitHub until you confirm a merge.
      </p>
    </div>
  );
}

function EngineOffline({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <AlertCircle className="h-7 w-7" />
      </div>
      <h2 className="text-xl font-semibold">Can&apos;t reach the engine</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        The panel couldn&apos;t connect to the Bureau engine at <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{ENGINE_URL}</code>. Start it, then retry.
      </p>
      <pre className="max-w-full overflow-x-auto rounded-lg border bg-muted/60 px-3 py-2 text-left font-mono text-xs">pnpm build &amp;&amp; pnpm dev</pre>
      <button
        onClick={onRetry}
        className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Retry
      </button>
      <p className="max-w-md text-xs text-muted-foreground/70">{message}</p>
    </div>
  );
}

function ChatBubble({ message, onRun }: { message: Message; onRun?: (cmd: string) => void }) {
  if (message.role === "system") {
    // A git-op result note links to Git (where the branch/tag now lives); a task note
    // links to its task; otherwise fall back to the task list.
    const href = message.taskId ? `/tasks/${message.taskId}` : message.id.startsWith("gitop-") ? "/git" : "/tasks";
    return (
      <div className="flex justify-center">
        <Link
          href={href}
          className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50"
        >
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          {message.content}
        </Link>
      </div>
    );
  }
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[90%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed sm:max-w-[82%]",
          isUser ? "whitespace-pre-wrap bg-primary text-primary-foreground" : "border bg-card"
        )}
      >
        {/* Iris replies are markdown (bold, lists, code, links); the CEO's own
            messages are shown verbatim. */}
        {isUser ? message.content : <Markdown source={message.content} onRun={onRun} />}
      </div>
    </div>
  );
}

function TypingIndicator({ activity }: { activity: string | null }) {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-2xl border bg-card px-4 py-3 text-muted-foreground">
        {activity ? (
          // A tool Iris just ran (Read/Grep/…) — live "what she's doing" while composing.
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            <span className="max-w-[18rem] truncate font-mono text-xs sm:max-w-md">{activity}</span>
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70" />
          </span>
        )}
      </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
function fmtCost(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
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
  // Forecast the pipeline's token + cost BEFORE the CEO commits to running it, and flag
  // when that forecast would blow the per-task budget cap (a runtime guard stops it anyway).
  const [est, setEst] = useState<CostEstimate | null>(null);
  const [budget, setBudget] = useState(0);
  useEffect(() => {
    let alive = true;
    estimateCost(proposal.steps.map((s) => s.capability))
      .then((e) => alive && setEst(e))
      .catch(() => alive && setEst(null));
    getConfig()
      .then((c) => alive && setBudget(c.budgetUsd))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [proposal]);
  const overBudget = budget > 0 && est !== null && est.totalCostUsd > budget;

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
      {proposal.context && (
        <div className="mb-3 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Brief the workers receive:</span>
          {"\n"}
          {proposal.context}
        </div>
      )}
      <div className="mb-4 space-y-1.5">
        {proposal.steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2.5 text-sm">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">{i + 1}</span>
            <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground">
              {ASSIGNEE[s.capability] ?? s.capability}
            </span>
            <span>{s.description}</span>
          </div>
        ))}
      </div>
      {est && (
        <div className={cn("mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs", overBudget ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground")}>
          <Coins className="h-3.5 w-3.5 shrink-0" />
          <span>≈ {fmtTokens(est.totalInputTokens + est.totalOutputTokens)} tokens</span>
          <span aria-hidden>·</span>
          <span className={cn("font-medium", overBudget ? "" : "text-foreground")}>~{fmtCost(est.totalCostUsd)}</span>
          {overBudget ? (
            <span className="font-medium">⚠ over your {fmtCost(budget)} cap — it&apos;ll stop mid-run</span>
          ) : (
            <span className="text-muted-foreground/70">
              · {est.perStep.some((p) => p.basis === "history") ? "from your past runs" : "rough estimate"}
            </span>
          )}
        </div>
      )}
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

let localSeq = 0;
function local(role: "user" | "iris", content: string): Message {
  return { id: `local-${role}-${++localSeq}`, role, content, createdAt: "" };
}
// Notes carry a REAL ISO timestamp (same clock/format the engine stamps messages with —
// localhost, no skew) so on reload they merge-sort back into their chronological slot in
// the thread instead of all piling up at the bottom.
function createdNote(taskId: string, title: string): Message {
  return { id: `created-${taskId}`, role: "system", content: `Created “${title}” — open it in Tasks`, taskId, createdAt: new Date().toISOString() };
}
function opNote(text: string): Message {
  return { id: `gitop-${++localSeq}`, role: "system", content: text, createdAt: new Date().toISOString() };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Merge persisted server messages with local action chips into one chronological log.
// Sort by ISO `createdAt`; empty timestamps (legacy notes saved before we stamped them)
// sort LAST, preserving their old end-of-thread placement. The index tiebreak keeps the
// sort stable (server messages before notes on an exact timestamp tie).
function mergeByTime(messages: Message[], notes: Message[]): Message[] {
  return [...messages, ...notes]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      // Missing timestamps (legacy notes saved before we stamped them) sort LAST,
      // preserving their old end-of-thread placement.
      const ta = a.m.createdAt,
        tb = b.m.createdAt;
      if (!ta && !tb) return a.i - b.i;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i; // index tiebreak keeps the sort stable
    })
    .map((x) => x.m);
}

// A pending task proposal is ephemeral UI state that the engine doesn't persist, so
// it survives reload / conversation-switch in localStorage, keyed by conversation.
const PROPOSAL_KEY = (convId: string) => `bureau.proposal.${convId}`;
function loadProposal(convId: string | null): TaskProposal | null {
  if (!convId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROPOSAL_KEY(convId));
    return raw ? (JSON.parse(raw) as TaskProposal) : null;
  } catch {
    return null;
  }
}
function persistProposal(convId: string | null, proposal: TaskProposal | null): void {
  if (!convId || typeof window === "undefined") return;
  try {
    if (proposal) window.localStorage.setItem(PROPOSAL_KEY(convId), JSON.stringify(proposal));
    else window.localStorage.removeItem(PROPOSAL_KEY(convId));
  } catch {
    /* storage unavailable — proposal just won't persist */
  }
}

// A pending git-op proposal — same ephemeral, per-conversation persistence as a task proposal.
const GITOP_KEY = (convId: string) => `bureau.gitop.${convId}`;
function loadGitOp(convId: string | null): GitOpRequest | null {
  if (!convId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GITOP_KEY(convId));
    return raw ? (JSON.parse(raw) as GitOpRequest) : null;
  } catch {
    return null;
  }
}
function persistGitOp(convId: string | null, gitOp: GitOpRequest | null): void {
  if (!convId || typeof window === "undefined") return;
  try {
    if (gitOp) window.localStorage.setItem(GITOP_KEY(convId), JSON.stringify(gitOp));
    else window.localStorage.removeItem(GITOP_KEY(convId));
  } catch {
    /* storage unavailable — git-op proposal just won't persist */
  }
}

// Action confirmations ("Created …" / git-op results) are client-only chips the engine
// doesn't store — persist them per conversation so they survive a reload / thread switch
// instead of vanishing the moment the chat re-loads from the server.
const NOTES_KEY = (convId: string) => `bureau.notes.${convId}`;
function loadNotes(convId: string | null): Message[] {
  if (!convId || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(NOTES_KEY(convId));
    return raw ? (JSON.parse(raw) as Message[]) : [];
  } catch {
    return [];
  }
}
function appendNote(convId: string | null, note: Message): void {
  if (!convId || typeof window === "undefined") return;
  try {
    const notes = loadNotes(convId);
    notes.push(note);
    window.localStorage.setItem(NOTES_KEY(convId), JSON.stringify(notes));
  } catch {
    /* storage unavailable — note just won't persist */
  }
}
function clearNotes(convId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(NOTES_KEY(convId));
  } catch {
    /* ignore */
  }
}

// Finished inline command runs — persisted per conversation so a transcript survives
// reload / thread-switch. Rehydrated STATICALLY (RunCommand `initial`), never re-executed.
type StoredRun = { id: number; command: string; result: RunResult };
const RUNS_KEY = (convId: string) => `bureau.runs.${convId}`;
function loadRuns(convId: string | null): StoredRun[] {
  if (!convId || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RUNS_KEY(convId));
    return raw ? (JSON.parse(raw) as StoredRun[]) : [];
  } catch {
    return [];
  }
}
function saveRuns(convId: string, runs: StoredRun[]): void {
  try {
    window.localStorage.setItem(RUNS_KEY(convId), JSON.stringify(runs.slice(-30))); // bound localStorage
  } catch {
    /* storage full / unavailable */
  }
}
function appendRun(convId: string | null, run: StoredRun): void {
  if (!convId || typeof window === "undefined") return;
  saveRuns(convId, [...loadRuns(convId).filter((r) => r.id !== run.id), run]); // de-dupe by id
}
function removeRun(convId: string | null, id: number): void {
  if (!convId || typeof window === "undefined") return;
  saveRuns(convId, loadRuns(convId).filter((r) => r.id !== id));
}
function clearRuns(convId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(RUNS_KEY(convId));
  } catch {
    /* ignore */
  }
}

/** Read a File as UTF-8 text or a data URL (base64), promisified. */
function readFile(file: File, mode: "text" | "dataURL"): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.onload = () => resolve(String(r.result ?? ""));
    if (mode === "text") r.readAsText(file);
    else r.readAsDataURL(file);
  });
}
