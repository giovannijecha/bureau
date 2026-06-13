"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, Check, FolderGit2, GitBranch } from "lucide-react";
import type { Project } from "@bureau/contracts";
import { cn } from "../lib/utils";

// Dropdown to pick the active project (repository) — so Iris knows where we work.
export function ProjectPicker({
  projects,
  active,
  onChange,
}: {
  projects: Project[];
  active: Project | null;
  onChange: (id: string) => void;
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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-accent"
      >
        <FolderGit2 className="h-4 w-4 text-primary" />
        <span className="max-w-[200px] truncate">{active ? `${active.owner}/${active.name}` : "Select project"}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1.5 w-72 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg">
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
