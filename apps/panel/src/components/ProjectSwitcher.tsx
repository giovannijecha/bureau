"use client";

// The project switcher: a trigger button (the active repo) that opens a centered,
// SEARCHABLE command-palette modal — so picking a repo scales to many projects instead
// of a long dropdown. Keyboard: type to filter, ↑/↓ to move, Enter to pick, Esc to close.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronsUpDown, Check, FolderGit2, GitBranch, Search, Settings2 } from "lucide-react";
import type { Project } from "@bureau/contracts";
import { useSettingsModal } from "./SettingsModal";
import { cn } from "../lib/utils";

export function ProjectSwitcher({
  projects,
  active,
  onChange,
  compact = false,
}: {
  projects: Project[];
  active: Project | null;
  onChange: (id: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (projects.length === 0) {
    return <span className="text-xs text-muted-foreground">No projects configured</span>;
  }

  const label = active ? `${active.owner}/${active.name}` : "Select project";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={label}
        aria-haspopup="dialog"
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1.5 font-medium transition-colors",
          compact
            ? "h-7 max-w-[220px] rounded-full bg-muted/60 px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            : "h-9 rounded-md border bg-background px-3 text-sm hover:bg-accent"
        )}
      >
        <FolderGit2 className={cn("shrink-0 text-primary", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronsUpDown className={cn("shrink-0 text-muted-foreground", compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
      </button>

      {open && (
        <ProjectPalette
          projects={projects}
          active={active}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            onChange(id);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function ProjectPalette({
  projects,
  active,
  onClose,
  onPick,
}: {
  projects: Project[];
  active: Project | null;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const { open: openSettings } = useSettingsModal();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? projects.filter((p) => `${p.owner}/${p.name}`.toLowerCase().includes(s)) : projects;
  }, [projects, q]);

  useEffect(() => {
    // Start the highlight on the active project (or the top when filtering).
    const idx = filtered.findIndex((p) => p.id === active?.id);
    setHi(q ? 0 : idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    // Block the page behind from scrolling under the modal.
    const overlay = overlayRef.current;
    const stop = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node) && !inputRef.current?.contains(e.target as Node)) e.preventDefault();
    };
    overlay?.addEventListener("wheel", stop, { passive: false });
    overlay?.addEventListener("touchmove", stop, { passive: false });
    return () => {
      overlay?.removeEventListener("wheel", stop);
      overlay?.removeEventListener("touchmove", stop);
      previouslyFocused?.focus?.(); // restore focus to the trigger on close
    };
  }, []);

  // Keep the highlighted row in view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  // Arrows + Enter drive the highlight (bound to the input, where focus lives by default).
  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered[hi];
      if (p) onPick(p.id);
    }
  }

  // Esc + a Tab focus-trap are bound to the whole dialog, so they work even after Tab
  // moves focus off the input onto a row (otherwise the palette would be un-dismissable).
  function onDialogKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      const f = dialogRef.current?.querySelectorAll<HTMLElement>('input, button, [href], [tabindex]:not([tabindex="-1"])');
      if (!f || f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const a = document.activeElement;
      if (e.shiftKey && a === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && a === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="animate-overlay-in fixed inset-0 z-[100] flex items-start justify-center overscroll-contain bg-black/60 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Switch project"
        onKeyDown={onDialogKeyDown}
        className="animate-dialog-in flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search projects…"
            role="combobox"
            aria-expanded="true"
            aria-controls="bureau-project-list"
            aria-activedescendant={filtered[hi] ? `bureau-proj-${filtered[hi].id}` : undefined}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            spellCheck={false}
          />
        </div>

        <div ref={listRef} id="bureau-project-list" role="listbox" aria-label="Projects" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">No projects match “{q}”.</p>
          ) : (
            filtered.map((p, i) => {
              const selected = active?.id === p.id;
              return (
                <button
                  key={p.id}
                  id={`bureau-proj-${p.id}`}
                  role="option"
                  aria-selected={i === hi}
                  data-idx={i}
                  onMouseMove={() => setHi(i)}
                  onClick={() => onPick(p.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                    i === hi ? "bg-accent" : "hover:bg-accent/50"
                  )}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <FolderGit2 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {p.owner}/{p.name}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <GitBranch className="h-3 w-3" /> {p.baseBranch}
                    </div>
                  </div>
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })
          )}
        </div>

        <button
          onClick={() => {
            onClose();
            openSettings("projects");
          }}
          className="flex shrink-0 items-center gap-2 border-t px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Settings2 className="h-3.5 w-3.5" /> Manage projects
        </button>
      </div>
    </div>,
    document.body
  );
}
