"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrainCircuit, Search, Plus, FileText, BookText, Loader2, X, Save } from "lucide-react";
import type { NoteSummary, Note } from "@bureau/contracts";
import { listNotes, getNote, saveNote } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { Markdown } from "../../components/Markdown";
import { cn } from "../../lib/utils";

type Pane = { mode: "view"; note: Note } | { mode: "new" } | { mode: "empty" };

export default function MemoryPage() {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [pane, setPane] = useState<Pane>({ mode: "empty" });
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

  // New journals land as tasks finish — refresh the list on any lifecycle event.
  useEngineEvents((e) => {
    if (e.type === "task_updated") void load(q);
  });

  async function open(path: string) {
    const note = await getNote(path);
    if (note && alive.current) setPane({ mode: "view", note });
  }

  async function onSaved(note: Note) {
    setPane({ mode: "view", note });
    await load(q);
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
          <button
            onClick={() => setPane({ mode: "new" })}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> New note
          </button>
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
                <li key={n.path}>
                  <button
                    onClick={() => void open(n.path)}
                    className={cn(
                      "w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                      pane.mode === "view" && pane.note.path === n.path && "bg-muted"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <KindIcon kind={n.kind} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
                    </div>
                    {n.excerpt && <p className="mt-1 line-clamp-2 pl-6 text-xs text-muted-foreground">{n.excerpt}</p>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Detail / composer */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {pane.mode === "new" ? (
          <Composer onCancel={() => setPane({ mode: "empty" })} onSaved={onSaved} />
        ) : pane.mode === "view" ? (
          <NoteView note={pane.note} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <BrainCircuit className="h-8 w-8 opacity-30" />
            <p>Bureau&apos;s durable brain.</p>
            <p className="max-w-xs text-xs">Task journals are written automatically; pick one on the left, or write a standard Iris should remember.</p>
          </div>
        )}
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

function NoteView({ note }: { note: Note }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center gap-2">
        <KindIcon kind={note.kind} />
        <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">{note.kind}</span>
        <code className="ml-auto font-mono text-xs text-muted-foreground">{note.path}</code>
      </div>
      <Markdown source={note.body} />
    </div>
  );
}

function Composer({ onCancel, onSaved }: { onCancel: () => void; onSaved: (n: Note) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy || title.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await saveNote(title.trim(), body));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">New note</h2>
        <button onClick={onCancel} className="text-muted-foreground transition-colors hover:text-foreground">
          <X className="h-5 w-5" />
        </button>
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title — e.g. Coding standards"
        className="mb-3 h-10 w-full rounded-md border bg-background px-3 text-sm font-medium outline-none focus:border-primary"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What should Iris remember? Markdown is supported."
        rows={16}
        className="w-full resize-y rounded-md border bg-background p-3 font-mono text-sm outline-none focus:border-primary"
      />
      {error && <p className="mt-2 text-sm text-destructive">⚠ {error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onCancel} className="inline-flex h-9 items-center rounded-md border bg-background px-3.5 text-sm font-medium transition-colors hover:bg-accent">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={busy || title.trim() === ""}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save note
        </button>
      </div>
    </div>
  );
}

