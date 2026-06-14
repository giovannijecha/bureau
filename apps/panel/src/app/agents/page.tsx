"use client";

import { Sparkles, Compass, Pencil, FlaskConical, Eye, FileText, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

interface Agent {
  name: string;
  role: string;
  desc: string;
  icon: LucideIcon;
  live: boolean;
}

const IRIS: Agent = {
  name: "Iris",
  role: "Orchestrator",
  desc: "The one you talk to. Holds the conversation, proposes tasks, and delegates each step to a capability worker. You keep Start / Stop / the final merge.",
  icon: Sparkles,
  live: true,
};

const WORKERS: Agent[] = [
  { name: "Planner", role: "plan", desc: "Breaks a request into ordered steps and acceptance criteria.", icon: Compass, live: false },
  { name: "Editor", role: "edit", desc: "Applies the change in an isolated git worktree, then surfaces the diff.", icon: Pencil, live: true },
  { name: "Tester", role: "test", desc: "Runs the repository's test suite against the change.", icon: FlaskConical, live: false },
  { name: "Reviewer", role: "review", desc: "Inspects the diff and flags issues before it reaches you.", icon: Eye, live: false },
  { name: "Scribe", role: "document", desc: "Updates docs, the README, or a changelog for the change.", icon: FileText, live: true },
];

export default function AgentsPage() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <AgentCard agent={IRIS} featured />

        <div>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Capability workers</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {WORKERS.map((a) => (
              <AgentCard key={a.role} agent={a} />
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Workers are stateless and replaceable — all durable context lives in the Task. <strong>Edit</strong> and{" "}
          <strong>document</strong> run today; plan / test / review land in later phases.
        </p>
      </div>
    </div>
  );
}

function AgentCard({ agent, featured = false }: { agent: Agent; featured?: boolean }) {
  const Icon = agent.icon;
  return (
    <div className={cn("rounded-xl border bg-card p-4", featured && "border-primary/30 bg-primary/5")}>
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            featured ? "bg-primary/15 text-primary" : "bg-muted text-foreground/70"
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{agent.name}</span>
            <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{agent.role}</span>
            <span
              className={cn(
                "ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                agent.live ? "border-green-500/40 text-green-500" : "border-border text-muted-foreground"
              )}
            >
              {agent.live ? "Live" : "Soon"}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{agent.desc}</p>
        </div>
      </div>
    </div>
  );
}
