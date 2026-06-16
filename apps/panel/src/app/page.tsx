"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  FolderGit2,
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import type { Message, TaskProposal, Conversation, Attachment } from "@bureau/contracts";
import { chat, createTask, listConversations, deleteConversation, messagesFor } from "../lib/api";
import { useProjects } from "../lib/useProjects";
import { ProjectPicker } from "../components/ProjectPicker";
import { ConversationsRail } from "../components/ConversationsRail";
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
  const { projects, active, activeId, setActiveId } = useProjects();
  const confirm = useConfirm();
  const router = useRouter();
  const runInTerminal = useCallback((cmd: string) => router.push(`/terminal?run=${encodeURIComponent(cmd)}`), [router]);
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<TaskProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [composerErr, setComposerErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    setError(null);
    try {
      setLog(await messagesFor(id));
    } catch {
      setLog([]);
    }
  }, []);

  const newChat = useCallback(() => {
    setConvId(null);
    setLog([]);
    setProposal(null);
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
  }, [log, busy, proposal]);

  async function onSend() {
    const content = input.trim();
    if (busy) return;
    if (input.length > MESSAGE_MAX) {
      setComposerErr(`Message is too long — keep it under ${MESSAGE_MAX.toLocaleString()} characters.`);
      return;
    }
    if (!content && attachments.length === 0) return;
    setBusy(true);
    setError(null);
    setComposerErr(null);
    setProposal(null);
    persistProposal(convId, null); // clear up-front so a failed send can't resurrect the old proposal
    const atts = attachments;
    const shown = content + (atts.length ? `${content ? "\n\n" : ""}📎 ${atts.map((a) => a.name).join(", ")}` : "");
    setLog((l) => [...l, local("user", shown)]);
    setInput("");
    setAttachments([]);
    try {
      const res = await chat(content, activeId ?? undefined, convId ?? undefined, atts.length ? atts : undefined);
      setLog((l) => [...l, res.reply]);
      setConvId(res.conversationId); // always adopt the server's authoritative thread id
      // Persist (or clear) the proposal for this thread so it survives reload / switch.
      setProposal(res.proposal ?? null);
      persistProposal(res.conversationId, res.proposal ?? null);
      void refreshConversations();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
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
      setProposal(null);
      persistProposal(convId, null);
      setLog((l) => [...l, createdNote(task.id, proposal.title)]);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const empty = log.length === 0 && !proposal;

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
              {active && (
                <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground">
                  <FolderGit2 className="h-3.5 w-3.5 text-primary" />
                  {active.owner}/{active.name}
                </span>
              )}
            </div>
          ) : (
            <div className="w-full space-y-3.5 px-6 py-6 lg:px-10">
              {log.map((m) => (
                <ChatBubble key={m.id} message={m} onRun={runInTerminal} />
              ))}
              {busy && <TypingIndicator />}
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
                <ProjectPicker compact projects={projects} active={active} onChange={setActiveId} />
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

function ChatBubble({ message, onRun }: { message: Message; onRun?: (cmd: string) => void }) {
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

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl border bg-card px-4 py-3">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70" />
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
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">{i + 1}</span>
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

let localSeq = 0;
function local(role: "user" | "iris", content: string): Message {
  return { id: `local-${role}-${++localSeq}`, role, content, createdAt: "" };
}
function createdNote(taskId: string, title: string): Message {
  return { id: `created-${taskId}`, role: "system", content: `Created “${title}” — open it in Tasks`, taskId, createdAt: "" };
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
