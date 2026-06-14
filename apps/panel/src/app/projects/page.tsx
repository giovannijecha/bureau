"use client";

import { FolderGit2, GitBranch, Check, ExternalLink } from "lucide-react";
import { useProjects } from "../../lib/useProjects";
import { cn } from "../../lib/utils";

export default function ProjectsPage() {
  const { projects, active, setActiveId, error } = useProjects();

  return (
    <div className="h-full overflow-y-auto p-6">
      <p className="mb-4 text-sm text-muted-foreground">
        Pick the active project — Iris scopes her work to it in the Assistant.
      </p>

      {error && <p className="mb-4 text-sm text-destructive">⚠ {error}</p>}

      {projects.length === 0 && !error ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
          <FolderGit2 className="h-6 w-6 opacity-40" />
          No projects configured. Set <code className="font-mono">BUREAU_PROJECTS</code> on the engine.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => {
            const isActive = active?.id === p.id;
            return (
              <div key={p.id} className={cn("rounded-xl border bg-card p-4 transition-colors", isActive && "border-primary/40")}>
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FolderGit2 className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">
                        {p.owner}/{p.name}
                      </span>
                      {isActive && (
                        <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <GitBranch className="h-3 w-3" />
                      {p.baseBranch}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  {isActive ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                      <Check className="h-3.5 w-3.5" />
                      Selected in Assistant
                    </span>
                  ) : (
                    <button
                      onClick={() => setActiveId(p.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium transition-colors hover:bg-accent"
                    >
                      Set active
                    </button>
                  )}
                  <a
                    href={`https://github.com/${p.owner}/${p.name}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    GitHub
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
