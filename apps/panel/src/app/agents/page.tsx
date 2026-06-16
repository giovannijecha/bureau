"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Compass, Telescope, Pencil, FlaskConical, Eye, FileText, type LucideIcon } from "lucide-react";
import type { WorkerStatus } from "@bureau/contracts";
import { getHub } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

// Persona blurbs + icons are presentation; whether a worker is actually built
// (implemented) and whether it's running right now come live from the engine —
// so this roster can never drift from reality.
const PERSONA: Record<string, { icon: LucideIcon; desc: string }> = {
  plan: { icon: Compass, desc: "Breaks a request into ordered steps and acceptance criteria." },
  research: { icon: Telescope, desc: "Investigates the codebase and the web/docs, returning a grounded findings brief." },
  edit: { icon: Pencil, desc: "Applies the change in an isolated git worktree, then surfaces the diff." },
  test: { icon: FlaskConical, desc: "Runs the repository's test suite against the change." },
  review: { icon: Eye, desc: "Inspects the diff and flags issues before it reaches you." },
  document: { icon: FileText, desc: "Updates docs, the README, or a changelog for the change." },
};

export default function AgentsPage() {
  const [workers, setWorkers] = useState<WorkerStatus[] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const hub = await getHub();
      if (alive.current) setWorkers(hub.workers);
    } catch {
      if (alive.current) setWorkers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEngineEvents(() => void load());

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Iris — the orchestrator */}
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold">Iris</span>
                <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">orchestrator</span>
                <span className="ml-auto rounded-full border border-green-500/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-green-500">
                  Live
                </span>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">
                The one you talk to. Holds the conversation, proposes tasks, and delegates each step to a capability worker. You keep Start / Stop /
                the final merge.
              </p>
            </div>
          </div>
        </div>

        <div>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Capability workers</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {(workers ?? []).map((w) => (
              <WorkerCard key={w.capability} w={w} />
            ))}
            {workers === null && <p className="text-sm text-muted-foreground">Loading…</p>}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Workers are stateless and replaceable — all durable context lives in the Task. The <strong>Live</strong> badge is computed from the
          engine&apos;s capability registry, so it always reflects what&apos;s actually built.
        </p>
      </div>
    </div>
  );
}

function WorkerCard({ w }: { w: WorkerStatus }) {
  const persona = PERSONA[w.capability] ?? { icon: Pencil, desc: "" };
  const Icon = persona.icon;
  return (
    <div className={cn("rounded-xl border bg-card p-4 transition-colors", w.live && "border-blue-500/40")}>
      <div className="flex items-start gap-3">
        <div className={cn("relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", w.live ? "bg-blue-500/10 text-blue-400" : "bg-muted text-foreground/70")}>
          <Icon className="h-5 w-5" />
          {w.live && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400 ring-2 ring-card" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{w.assignee}</span>
            <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{w.capability}</span>
            <span
              className={cn(
                "ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                w.implemented ? "border-green-500/40 text-green-500" : "border-border text-muted-foreground"
              )}
            >
              {w.implemented ? "Live" : "Soon"}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{persona.desc}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground/80">{w.totalStepCount}</span> step{w.totalStepCount === 1 ? "" : "s"} run
            </span>
            {w.live && (
              <span className="inline-flex items-center gap-1 font-medium text-blue-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                running now ({w.runningStepCount})
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
