"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DollarSign, ArrowDownToLine, ArrowUpFromLine, Hash, Cpu, type LucideIcon } from "lucide-react";
import type { UsageSummary } from "@bureau/contracts";
import { getUsage } from "../../lib/api";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { cn } from "../../lib/utils";

const PERIODS: { label: string; days?: number }[] = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "All time" },
];

const SCOPE_LABEL: Record<string, string> = {
  iris: "Iris (chat)",
  plan: "Planner",
  edit: "Editor",
  test: "Tester",
  review: "Reviewer",
  document: "Scribe",
};

export default function MetricsPage() {
  const [period, setPeriod] = useState(1); // default 30 days
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (days?: number) => {
    try {
      const u = await getUsage(days);
      if (alive.current) setUsage(u);
    } catch {
      if (alive.current) setUsage({ totals: { inputTokens: 0, outputTokens: 0, costUsd: 0, events: 0 }, byScope: [], byModel: [], byDay: [], sinceDay: null });
    }
  }, []);

  useEffect(() => {
    void load(PERIODS[period]!.days);
  }, [period, load]);

  useEngineEvents((e) => {
    if (e.type === "task_updated" || e.type === "iris_message") void load(PERIODS[period]!.days);
  });

  const maxScopeCost = Math.max(1e-9, ...(usage?.byScope ?? []).map((s) => s.costUsd));
  const maxDay = Math.max(1, ...(usage?.byDay ?? []).map((d) => d.inputTokens + d.outputTokens));

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        {/* Period toggle */}
        <div className="flex items-center gap-1.5">
          {PERIODS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPeriod(i)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                i === period ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Totals */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={DollarSign} label="Est. cost" value={usage ? fmtUsd(usage.totals.costUsd) : "—"} tint="text-green-500" ring="bg-green-500/10" />
          <Stat icon={ArrowDownToLine} label="Input tokens" value={usage ? fmtTokens(usage.totals.inputTokens) : "—"} tint="text-blue-400" ring="bg-blue-500/10" />
          <Stat icon={ArrowUpFromLine} label="Output tokens" value={usage ? fmtTokens(usage.totals.outputTokens) : "—"} tint="text-amber-500" ring="bg-amber-500/10" />
          <Stat icon={Hash} label="Calls" value={usage ? String(usage.totals.events) : "—"} tint="text-foreground" ring="bg-muted" />
        </div>

        {usage && usage.totals.events === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
            <Cpu className="h-6 w-6 opacity-40" />
            No usage in this period yet. Chat with Iris or run a task — spend shows up here.
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {/* Cost by worker */}
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b px-4 py-3 text-sm font-semibold">Cost by worker</div>
              <div className="space-y-3 p-4">
                {(usage?.byScope ?? []).map((s) => (
                  <div key={s.scope}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium">{SCOPE_LABEL[s.scope] ?? s.scope}</span>
                      <span className="text-muted-foreground">
                        {fmtUsd(s.costUsd)} · {fmtTokens(s.inputTokens + s.outputTokens)} tok
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (s.costUsd / maxScopeCost) * 100)}%` }} />
                    </div>
                  </div>
                ))}
                {(usage?.byScope ?? []).length === 0 && <p className="text-sm text-muted-foreground">No data.</p>}
              </div>
            </div>

            {/* By model */}
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="border-b px-4 py-3 text-sm font-semibold">By model</div>
              <div className="divide-y">
                {(usage?.byModel ?? []).map((m) => (
                  <div key={m.model} className="flex items-center gap-3 px-4 py-2.5">
                    <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{m.model}</code>
                    <span className="shrink-0 text-xs text-muted-foreground">{fmtTokens(m.inputTokens + m.outputTokens)} tok</span>
                    <span className="shrink-0 text-xs font-medium text-green-500">{fmtUsd(m.costUsd)}</span>
                  </div>
                ))}
                {(usage?.byModel ?? []).length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No data.</p>}
              </div>
            </div>

            {/* Daily spend */}
            {usage && usage.byDay.length > 0 && (
              <div className="overflow-hidden rounded-xl border bg-card lg:col-span-2">
                <div className="border-b px-4 py-3 text-sm font-semibold">Tokens per day</div>
                <div className="flex items-end gap-1.5 p-4" style={{ height: 140 }}>
                  {usage.byDay.map((d) => {
                    const total = d.inputTokens + d.outputTokens;
                    return (
                      <div key={d.day} className="group flex flex-1 flex-col items-center justify-end gap-1" title={`${d.day}: ${fmtTokens(total)} tok · ${fmtUsd(d.costUsd)}`}>
                        <div className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary" style={{ height: `${Math.max(3, (total / maxDay) * 100)}%` }} />
                        <span className="text-[10px] text-muted-foreground">{d.day.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tint, ring }: { icon: LucideIcon; label: string; value: string; tint: string; ring: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", ring)}>
          <Icon className={cn("h-5 w-5", tint)} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-2xl font-bold leading-none tracking-tight">{value}</div>
          <div className="mt-1.5 truncate text-xs text-muted-foreground">{label}</div>
        </div>
      </div>
    </div>
  );
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
