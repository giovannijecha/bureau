"use client";

// A compact, EPHEMERAL Iris chat embedded in the Terminal page's right column — so the
// CEO can work inline with Iris while inspecting the repo. Nothing is persisted (the
// turn carries its own history), so it never clutters the Assistant. Reuses the same
// Iris flow (she sees recent terminal output) + Markdown renderer + attachments. A
// command Iris proposes (```bash) PRE-FILLS the terminal input via onRunCommand —
// never auto-runs (the CEO presses Enter).

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import {
  Sparkles,
  Send,
  Loader2,
  ArrowRight,
  Pencil,
  CheckCircle2,
  Workflow,
  AlertCircle,
  Paperclip,
  X,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import type { Message, TaskProposal, Attachment } from "@bureau/contracts";
import { chatEphemeral, createTask } from "../lib/api";
import { Markdown } from "./Markdown";
import { cn } from "../lib/utils";

const ASSIGNEE: Record<string, string> = { plan: "Planner", research: "Researcher", edit: "Editor", test: "Tester", review: "Reviewer", document: "Scribe" };

let seq = 0;
function localMsg(role: "user" | "system", content: string, taskId?: string): Message {
  return { id: `dock-${role}-${++seq}`, role, content, createdAt: "", ...(taskId ? { taskId } : {}) };
}

export function IrisDock({
  projectId,
  onRunCommand,
  emptyHint,
  suggestion,
}: {
  projectId: string | null | undefined;
  /** Terminal pages pass this so a proposed command pre-fills the input. Optional —
   *  omit it (e.g. the Memory dock) and Iris just chats (no "Run in terminal" button). */
  onRunCommand?: ((cmd: string) => void) | undefined;
  /** Intro line shown when the chat is empty (defaults to the terminal phrasing). */
  emptyHint?: string | undefined;
  /** A one-tap prompt the host surfaces above the composer (e.g. the Memory page passes
   *  the open note). Clicking it pre-fills `prompt` and, if `attach` is given, sends that
   *  text along ONCE so Iris can see content she doesn't already hold in context. */
  suggestion?: { label: string; prompt: string; attach?: { name: string; content: string } } | undefined;
}) {
  const [input, setInput] = useState("");
  const [log, setLog] = useState<Message[]>([]);
  const [proposal, setProposal] = useState<TaskProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [composerErr, setComposerErr] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // A note (etc.) the host attached via `suggestion` — sent silently on the NEXT send only,
  // then cleared (it's in the chat history afterwards, no need to resend each turn).
  const pendingAttach = useRef<Attachment | null>(null);

  function applySuggestion() {
    if (!suggestion) return;
    setInput(suggestion.prompt);
    pendingAttach.current = suggestion.attach ? { name: suggestion.attach.name, kind: "text", content: suggestion.attach.content } : null;
    inputRef.current?.focus();
  }

  // Switching the active project starts a fresh, empty session (Iris is scoped per repo).
  useEffect(() => {
    setLog([]);
    setProposal(null);
    setError(null);
    setAttachments([]);
    setComposerErr(null);
    pendingAttach.current = null;
  }, [projectId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log, busy, proposal]);

  async function onSend() {
    const content = input.trim();
    const ctx = pendingAttach.current; // host-attached context (e.g. the open note), if armed
    if ((!content && attachments.length === 0 && !ctx) || busy) return;
    pendingAttach.current = null;
    // Carry the prior turns inline — the engine persists nothing for this dock.
    const history = log
      .filter((m) => m.role === "user" || m.role === "iris")
      .map((m) => ({ role: m.role as "user" | "iris", content: m.content }));
    const userAtts = attachments;
    const sendAtts = ctx ? [...userAtts, ctx] : userAtts; // ctx rides along but isn't shown as a chip
    const shown = content + (userAtts.length ? `${content ? "\n" : ""}📎 ${userAtts.map((a) => a.name).join(", ")}` : "");
    setBusy(true);
    setError(null);
    setComposerErr(null);
    setProposal(null);
    setLog((l) => [...l, localMsg("user", shown)]);
    setInput("");
    setAttachments([]);
    try {
      const res = await chatEphemeral(content, projectId ?? undefined, history, sendAtts.length ? sendAtts : undefined);
      setLog((l) => [...l, res.reply]);
      setProposal(res.proposal ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    const room = 8 - attachments.length;
    if (room <= 0) {
      setComposerErr("You can attach up to 8 files.");
      return;
    }
    let msg: string | null = null;
    const next: Attachment[] = [];
    for (const file of files.slice(0, room)) {
      try {
        if (file.type.startsWith("image/")) {
          if (file.size > 8_000_000) {
            msg = `“${file.name}” is too large (max 8 MB).`;
            continue;
          }
          const dataUrl = await readFile(file, "dataURL");
          next.push({
            name: file.name,
            kind: "image",
            content: dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl,
            mediaType: file.type || "image/png",
          });
        } else {
          if (file.size > 256_000) {
            msg = `“${file.name}” is too large (max 256 KB for text).`;
            continue;
          }
          next.push({ name: file.name, kind: "text", content: await readFile(file, "text") });
        }
      } catch {
        msg = `Couldn’t read “${file.name}”.`;
      }
    }
    if (!msg && files.length > room) msg = `Added the first ${room} — max 8 attachments.`;
    setComposerErr(msg);
    if (next.length) setAttachments((a) => [...a, ...next]);
  }

  async function onCreate() {
    if (!proposal || busy) return;
    setBusy(true);
    setError(null);
    const title = proposal.title;
    try {
      const task = await createTask(proposal, projectId ?? undefined);
      setProposal(null);
      setLog((l) => [...l, localMsg("system", `Created “${title}” — open it in Tasks`, task.id)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function refine() {
    setProposal(null);
    setInput("Let's refine that: ");
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Iris</span>
        <span className="rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">temporary</span>
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {log.length === 0 && !busy && (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            {emptyHint ??
              "Ask Iris about the repo or what you're seeing in the terminal — she can answer, propose a read-only command (it pre-fills on the left, you press Enter), or draft a task. This chat is temporary; use the Assistant for ongoing work."}
          </p>
        )}
        {log.map((m) => (
          <DockBubble key={m.id} m={m} onRun={onRunCommand} />
        ))}
        {busy && <DockTyping />}
        {proposal && <DockProposal proposal={proposal} busy={busy} onCreate={onCreate} onRefine={refine} />}
        {error && (
          <p className="flex items-start gap-1.5 px-1 text-xs text-destructive">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t p-2.5">
        {/* A one-tap "ask about <the thing you're looking at>" — pre-fills + attaches it. */}
        {suggestion && !input && !busy && (
          <button
            onClick={applySuggestion}
            title={`Ask Iris about “${suggestion.label}”`}
            className="mb-2 flex max-w-full items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">Ask about “{suggestion.label}”</span>
          </button>
        )}
        <div className="rounded-xl border bg-background transition-colors focus-within:border-primary/50">
          <textarea
            ref={inputRef}
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            rows={1}
            placeholder="Ask Iris…"
            className="max-h-28 min-h-[28px] w-full resize-none bg-transparent px-2.5 pt-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pb-0.5">
              {attachments.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px]">
                  {a.kind === "image" ? <ImageIcon className="h-3 w-3 shrink-0 text-primary" /> : <FileText className="h-3 w-3 shrink-0 text-amber-500" />}
                  <span className="max-w-[120px] truncate">{a.name}</span>
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5 pt-1">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              title="Attach images or files"
              aria-label="Attach"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
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
            <button
              onClick={() => void onSend()}
              disabled={busy || (!input.trim() && attachments.length === 0)}
              aria-label="Send"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {composerErr && (
          <p className="mt-1.5 flex items-start gap-1.5 px-1 text-xs text-destructive">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{composerErr}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function DockBubble({ m, onRun }: { m: Message; onRun?: ((cmd: string) => void) | undefined }) {
  if (m.role === "system") {
    return (
      <div className="flex justify-center">
        <Link
          href={m.taskId ? `/tasks/${m.taskId}` : "/tasks"}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> {m.content}
        </Link>
      </div>
    );
  }
  const isUser = m.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed",
          isUser ? "whitespace-pre-wrap bg-primary text-primary-foreground" : "border bg-card"
        )}
      >
        {isUser ? m.content : <Markdown source={m.content} onRun={onRun} />}
      </div>
    </div>
  );
}

function DockTyping() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-xl border bg-card px-3 py-2.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70" />
      </div>
    </div>
  );
}

function DockProposal({
  proposal,
  busy,
  onCreate,
  onRefine,
}: {
  proposal: TaskProposal;
  busy: boolean;
  onCreate: () => void;
  onRefine: () => void;
}) {
  return (
    <div className="rounded-xl border border-primary/30 bg-card p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <Workflow className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="text-sm font-semibold">{proposal.title}</span>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{proposal.summary}</p>
      {proposal.context && (
        <div className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Brief:</span> {proposal.context}
        </div>
      )}
      <div className="mb-2.5 space-y-1">
        {proposal.steps.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <span className="shrink-0 rounded-md border bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {ASSIGNEE[s.capability] ?? s.capability}
            </span>
            <span className="min-w-0 flex-1">{s.description}</span>
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onCreate}
          disabled={busy}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />} Create task
        </button>
        <button
          onClick={onRefine}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5" /> Refine
        </button>
      </div>
    </div>
  );
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
