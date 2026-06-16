"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, Check, FolderGit2, GitBranch } from "lucide-react";
import type { Project } from "@bureau/contracts";
import { cn } from "../lib/utils";

// Dropdown to pick the active project (repository) — so Iris knows where we work.
// `compact` renders a subtle pill that opens UPWARD, for use inside the composer.
export function ProjectPicker({
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (projects.length === 0) {
    return <span className="text-xs text-muted-foreground">No projects configured</span>;
  }

  const label = active ? `${active.owner}/${active.name}` : "Select project";

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title={label}
        className={cn(
          // flex + min-w-0 + max-w-full so the label truncates instead of overflowing a
          // narrow container (e.g. the IrisDock header), rather than getting clipped.
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
        <div
          className={cn(
            "absolute z-30 w-72 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg",
            compact ? "bottom-full left-0 mb-1.5" : "right-0 mt-1.5"
          )}
        >
          <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Projects</div>
          {projects.map((p) => {
            const selected = active?.id === p.id;
            return (
              <button
                key={p.id}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-accent",
                  selected && "bg-accent/60"
                )}
              >
                <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {p.owner}/{p.name}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3" />
                    {p.baseBranch}
                  </div>
                </div>
                {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
