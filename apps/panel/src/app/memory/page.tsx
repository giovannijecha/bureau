"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { BrainCircuit, Search, Plus, FileText, BookText, Loader2, X, Save, Pencil, Trash2, Upload, Eye, Code2, AlertCircle, Wand2, Archive, FilePlus2, CheckSquare, Square, ListChecks } from "lucide-react";
import type { NoteSummary, Note, CurationPlan, CurationAction, CurationStatus } from "@bureau/contracts";
import { listNotes, getNote, saveNote, deleteNote, curateMemory, applyCuration, curationStatus } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { useConfirm } from "../../components/ConfirmDialog";
import { Markdown } from "../../components/Markdown";
import { FieldError } from "../../components/FieldError";
import { IrisDock } from "../../components/IrisDock";
import { useProjects } from "../../lib/useProjects";
import { cn } from "../../lib/utils";

type Compose = { title: string; body: string; path: string | null };
type Pane = { mode: "view"; note: Note } | { mode: "compose"; initial: Compose } | { mode: "empty" };

export default function MemoryPage() {
  const confirm = useConfirm();
  const { activeId } = useProjects();
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [pane, setPane] = useState<Pane>({ mode: "empty" });
  const [notice, setNotice] = useState<string | null>(null);
  // Memory curation (the Archivist): the proposed plan under review, a busy flag, the rolling
  // status (last curated / how due), and the auto-nudge banner.
  const [plan, setPlan] = useState<CurationPlan | null>(null);
  const [curating, setCurating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<CurationStatus | null>(null);
  const [due, setDue] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (query: string) => {
    try {
      const list = await listNotes(query);
      if (alive.current) setNotes(list);
    } catch {
      if (alive.current) setNotes([]);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(q), 200); // debounce search
    return () => clearTimeout(t);
  }, [q, load]);

  const loadStatus = useCallback(async () => {
    try {
      const s = await curationStatus();
      if (!alive.current) return;
      setStatus(s);
      // Surface the nudge on load too (in case the live WS event fired while the page was closed).
      if (s.tasksSinceCuration >= s.curateEvery) setDue(true);
    } catch {
      /* engine offline — leave as-is */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // New journals land as tasks finish — refresh the list on any lifecycle event; the vault can
  // cross the auto-curation threshold → show a non-blocking "tidy memory" nudge.
  useEngineEvents(
    (e) => {
      if (e.type === "task_updated") {
        void load(q);
        void loadStatus();
      } else if (e.type === "curation_due") {
        setDue(true);
        void loadStatus();
      }
    },
    () => {
      void load(q);
      void loadStatus();
    }
  ); // re-sync on reconnect / tab-return

  async function curate() {
    if (curating) return;
    setCurating(true);
    setNotice(null);
    try {
      const p = await curateMemory("manual");
      if (!alive.current) return;
      setPlan(p);
      setDue(false);
    } catch (e) {
      if (alive.current) setNotice(e instanceof Error ? e.message : "Couldn’t curate memory.");
    } finally {
      if (alive.current) setCurating(false);
    }
  }

  async function applyPlan(accept: number[]) {
    if (!plan || applying) return; // re-entry guard — a fast double-click can't apply twice
    setApplying(true);
    try {
      const ok = await confirm({
        title: "Apply these memory changes?",
        description:
          "Compact and prune move the original notes to a reversible archive (kept on disk, never hard-deleted). Promote creates a new pinned note. Audit-only items change nothing.",
        confirmLabel: "Apply",
      });
      if (!ok) return;
      const s = await applyCuration(plan, accept);
      if (!alive.current) return;
      setStatus(s);
      setPlan(null);
      await load(q);
    } catch (e) {
      if (alive.current) setNotice(e instanceof Error ? e.message : "Couldn’t apply the curation.");
    } finally {
      if (alive.current) setApplying(false);
    }
  }

  const open = useCallback(
    async (path: string) => {
      try {
        const note = await getNote(path);
        if (alive.current) setPane({ mode: "view", note });
      } catch {
        // The note likely vanished (deleted elsewhere) or the engine is offline.
        if (alive.current) {
          setPane({ mode: "empty" });
          setNotice("Couldn’t open that note — it may have been removed.");
          void load(q);
        }
      }
    },
    [load, q]
  );

  async function onSaved(note: Note) {
    setPane({ mode: "view", note });
    await load(q);
  }

  async function removeNote(note: { path: string; title: string }) {
    const ok = await confirm({
      title: "Delete note?",
      description: `“${note.title}” will be permanently removed from the vault. This can't be undone.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await deleteNote(note.path);
    } catch {
      /* ignore */
    }
    // Clear the pane whether the note was being viewed OR edited — otherwise the
    // open editor would still let Save resurrect the just-deleted file.
    setPane((p) =>
      (p.mode === "view" && p.note.path === note.path) || (p.mode === "compose" && p.initial.path === note.path) ? { mode: "empty" } : p
    );
    await load(q);
  }

  // Upload a .md/.txt file → open the composer pre-filled (the CEO reviews, then saves).
  function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (!file) return;
    setNotice(null);
    if (file.size > 1_000_000) {
      setNotice(`“${file.name}” is too large (max 1 MB for a note).`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setNotice(`Couldn’t read “${file.name}”.`);
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const title = file.name.replace(/\.(md|markdown|txt)$/i, "");
      setPane({ mode: "compose", initial: { title, body: text, path: null } });
    };
    reader.readAsText(file);
  }

  const list = notes ?? [];

  return (
    <div className="flex h-full overflow-hidden">
      {/* List rail */}
      <div className="flex w-80 shrink-0 flex-col border-r">
        <div className="space-y-2.5 border-b p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search memory…"
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPane({ mode: "compose", initial: { title: "", body: "", path: null } })}
              className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> New note
            </button>
            <button
              onClick={() => void curate()}
              disabled={curating}
              title="Curate memory — the Archivist proposes tidy-ups (you approve each)"
              className={cn(
                "inline-flex h-9 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-60",
                due && "border-primary/50 text-primary"
              )}
            >
              {curating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              title="Upload a .md or .txt file"
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent"
            >
              <Upload className="h-4 w-4" />
            </button>
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden" onChange={onUpload} />
          </div>
          {due ? (
            <button
              onClick={() => void curate()}
              className="flex w-full items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/10"
            >
              <Wand2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">Memory grew by {status?.curateEvery ?? 10}+ tasks — tidy it up?</span>
            </button>
          ) : status?.lastCuratedAt ? (
            <p className="px-0.5 text-[11px] text-muted-foreground">Last curated {relTime(status.lastCuratedAt)}.</p>
          ) : null}
        </div>
        <div className="flex-1 overflow-y-auto">
          {notes === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <BrainCircuit className="h-6 w-6 opacity-40" />
              {q ? "No notes match." : "No memory yet. Task journals appear here as tasks finish — or write a note."}
            </div>
          ) : (
            <ul className="divide-y">
              {list.map((n) => (
                <li key={n.path} className="group/note relative">
                  <button
                    onClick={() => void open(n.path)}
                    className={cn(
                      "w-full px-3 py-2.5 pr-9 text-left transition-colors hover:bg-muted/50",
                      pane.mode === "view" && pane.note.path === n.path && "bg-muted"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <KindIcon kind={n.kind} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
                    </div>
                    {n.excerpt && <p className="mt-1 line-clamp-2 pl-6 text-xs text-muted-foreground">{n.excerpt}</p>}
                  </button>
                  <button
                    onClick={() => void removeNote(n)}
                    title="Delete note"
                    className="absolute right-2 top-2.5 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-500 focus:opacity-100 group-hover/note:opacity-100"
                    aria-label="Delete note"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Detail / composer */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {notice && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="shrink-0 transition-colors hover:text-foreground" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
        {pane.mode === "compose" ? (
          <Composer key={pane.initial.path ?? "new"} initial={pane.initial} onCancel={() => setPane({ mode: "empty" })} onSaved={onSaved} />
        ) : pane.mode === "view" ? (
          <NoteView
            note={pane.note}
            onEdit={() => setPane({ mode: "compose", initial: { title: pane.note.title, body: stripH1(pane.note.body, pane.note.title), path: pane.note.path } })}
            onDelete={() => void removeNote(pane.note)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <BrainCircuit className="h-8 w-8 opacity-30" />
            <p className="font-medium text-foreground/80">Bureau&apos;s durable brain</p>
            <p className="max-w-sm text-xs">
              Task journals are written automatically. Write or upload a note Iris should remember, or pick one on the left to read, edit, or ask Iris about it.
            </p>
          </div>
        )}
        </div>
      </div>

      {plan && <CurationReview plan={plan} busy={applying} onClose={() => setPlan(null)} onApply={applyPlan} />}

      {/* Iris dock — your personal memory assistant (hidden on narrow screens) */}
      <div className="hidden w-[360px] shrink-0 flex-col overflow-hidden border-l lg:flex">
        <IrisDock
          projectId={activeId}
          suggestion={
            pane.mode === "view"
              ? { label: pane.note.title, prompt: `About “${pane.note.title}” — `, attach: { name: `${pane.note.title}.md`, content: pane.note.body } }
              : undefined
          }
          emptyHint="Your memory assistant. Open a note and tap “Ask about” to bring it into the chat — Iris can explain it, spot overlaps or stale/duplicate entries, and suggest cleaner wording. She reads your pinned notes; apply any edits from the editor on the left."
        />
      </div>
    </div>
  );
}

function KindIcon({ kind }: { kind: NoteSummary["kind"] }) {
  return kind === "journal" ? (
    <BookText className="h-4 w-4 shrink-0 text-primary" />
  ) : (
    <FileText className="h-4 w-4 shrink-0 text-amber-500" />
  );
}

function NoteView({ note, onEdit, onDelete }: { note: Note; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-6 py-3">
        <KindIcon kind={note.kind} />
        <span className="rounded-full border px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">{note.kind}</span>
        <code className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{note.path}</code>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Iris lives in the dock on the right — open a note and use "Ask about" there.
              Journals are auto-generated task records — editing one would fork it into
              a free-form note and delete the journal, so only notes are editable. */}
          {note.kind !== "journal" && (
            <button onClick={onEdit} className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent">
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          )}
          <button onClick={onDelete} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500">
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          <Markdown source={note.body} />
        </div>
      </div>
    </div>
  );
}

function Composer({ initial, onCancel, onSaved }: { initial: Compose; onCancel: () => void; onSaved: (n: Note) => void }) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy || title.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveNote(title.trim(), body, initial.path ?? undefined);
      // Renamed an existing note (its path changed) → remove the old file.
      if (initial.path && initial.path !== saved.path) {
        await deleteNote(initial.path).catch(() => {});
      }
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const editing = initial.path !== null;
  // Memoize the preview so typing doesn't re-parse the whole document every keystroke.
  const preview = useMemo(() => (body.trim() === "" ? null : <Markdown source={body} />), [body]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-6 py-3">
        <Pencil className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">{editing ? "Edit note" : "New note"}</h2>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
          <Eye className="h-3.5 w-3.5" /> live preview
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button onClick={onCancel} className="inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-accent">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || title.trim() === ""}
            title={title.trim() === "" ? "Add a title to save" : undefined}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>
        </div>
      </div>

      <div className="shrink-0 border-b px-6 py-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title — e.g. Coding standards"
          autoFocus={!editing}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-medium outline-none focus:border-primary"
        />
        {title.trim() === "" && !error && <p className="mt-1.5 text-xs text-muted-foreground">A title is required to save.</p>}
        <FieldError message={error} />
      </div>

      {/* Split: editor + live preview (stacks on narrow screens). */}
      <div className="grid min-h-0 flex-1 grid-rows-2 divide-y lg:grid-cols-2 lg:grid-rows-1 lg:divide-x lg:divide-y-0">
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-1.5 px-4 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Code2 className="h-3.5 w-3.5" /> Markdown
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What should Iris remember? Markdown is supported — headings, lists, **bold**, `code`, ```fences```, links."
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-2.5 font-mono text-sm leading-relaxed outline-none"
            spellCheck={false}
          />
        </div>
        <div className="flex min-h-0 flex-col bg-muted/20">
          <div className="flex items-center gap-1.5 px-4 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Eye className="h-3.5 w-3.5" /> Preview
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2.5 text-sm">
            {preview ?? <p className="text-muted-foreground">Nothing to preview yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A short relative time ("2h ago", "just now") for the "last curated" line. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const CURATE_OP: Record<CurationAction["kind"], { label: string; icon: typeof Archive; cls: string }> = {
  audit: { label: "Audit", icon: AlertCircle, cls: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  compact: { label: "Compact", icon: ListChecks, cls: "border-blue-500/40 text-blue-600 dark:text-blue-400" },
  promote: { label: "Promote", icon: FilePlus2, cls: "border-green-500/40 text-green-600 dark:text-green-400" },
  prune: { label: "Prune", icon: Archive, cls: "border-red-500/40 text-red-600 dark:text-red-400" },
};

/** The curation review modal — the CEO approves individual actions before anything is applied.
 *  Audit items are advisory (no checkbox); compact/promote/prune are selectable and reversible. */
function CurationReview({ plan, busy, onClose, onApply }: { plan: CurationPlan; busy: boolean; onClose: () => void; onApply: (accept: number[]) => void }) {
  // Pre-select every actionable item (audit changes nothing, so it's never selected/applied).
  const actionable = (i: number) => plan.actions[i]!.kind !== "audit";
  const [accept, setAccept] = useState<Set<number>>(() => new Set(plan.actions.map((_, i) => i).filter(actionable)));
  const toggle = (i: number) => setAccept((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const selectedCount = [...accept].filter(actionable).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-start gap-3 border-b px-5 py-3.5">
          <Wand2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Memory curation</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{plan.summary}</p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
          {plan.actions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
              <BrainCircuit className="h-7 w-7 opacity-40" />
              Memory is already tidy — nothing to curate.
            </div>
          ) : (
            plan.actions.map((a, i) => {
              const meta = CURATE_OP[a.kind];
              const Icon = meta.icon;
              const selectable = a.kind !== "audit";
              const on = accept.has(i);
              return (
                <div key={i} className={cn("rounded-lg border p-3", selectable && on ? "border-primary/40 bg-primary/[0.03]" : "bg-background")}>
                  <div className="flex items-start gap-2.5">
                    {selectable ? (
                      <button onClick={() => toggle(i)} className="mt-0.5 shrink-0 text-primary" aria-label={on ? "Deselect" : "Select"}>
                        {on ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4 text-muted-foreground" />}
                      </button>
                    ) : (
                      <span className="mt-0.5 shrink-0 text-muted-foreground"><Square className="h-4 w-4 opacity-30" /></span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", meta.cls)}>
                          <Icon className="h-3 w-3" /> {meta.label}
                        </span>
                        {a.kind === "audit" && <span className="text-[11px] text-muted-foreground">advisory — changes nothing</span>}
                      </div>
                      <p className="text-sm">{a.reason}</p>
                      {a.paths.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {a.paths.map((p) => (
                            <li key={p} className="truncate font-mono text-[11px] text-muted-foreground">{p}</li>
                          ))}
                        </ul>
                      )}
                      {a.kind === "compact" && a.digestTitle && (
                        <DigestPreview title={a.digestTitle} body={a.digestBody ?? ""} />
                      )}
                      {a.kind === "promote" && a.noteTitle && (
                        <DigestPreview title={a.noteTitle} body={a.noteBody ?? ""} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">{selectedCount} selected · originals archived (reversible)</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose} className="inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-accent">
              Cancel
            </button>
            <button
              onClick={() => onApply([...accept].filter(actionable))}
              disabled={selectedCount === 0 || busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckSquare className="h-3.5 w-3.5" />} Apply selected
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A collapsed preview of a compact digest / promoted note's content. */
function DigestPreview({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 rounded-md border bg-muted/30">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <Eye className="h-3.5 w-3.5" /> {open ? "Hide" : "Preview"}: {title}
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto border-t px-3 py-2 text-sm">
          <Markdown source={`# ${title}\n\n${body}`} />
        </div>
      )}
    </div>
  );
}

/** Strip a leading "# Title" line (the vault stores notes with an H1) so editing
 *  shows just the body — saveNote re-adds the H1. */
function stripH1(markdown: string, title: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() === `# ${title}`) {
    let i = 1;
    while (i < lines.length && lines[i]!.trim() === "") i++; // drop the blank line after the H1
    return lines.slice(i).join("\n").trimEnd();
  }
  return markdown;
}
