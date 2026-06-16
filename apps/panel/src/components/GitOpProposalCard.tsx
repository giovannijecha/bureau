"use client";

// Iris's inline git-op proposal, rendered in the Assistant chat. The CEO reviews the
// (pre-filled, editable) operation and authorizes it with one click — destructive ops
// require typing the branch name to confirm. It runs through the SAME gated /api/git/op
// endpoint as the Operations tab (the engine re-validates the confirm + every ref).

import { useState } from "react";
import { AlertTriangle, Loader2, Wrench, X } from "lucide-react";
import type { GitOpRequest } from "@bureau/contracts";
import { DESTRUCTIVE_GIT_OPS } from "@bureau/contracts";
import { runGitOp } from "../lib/api";
import { gitOpMeta, GIT_OP_FIELD_LABELS as LABELS, BRANCH_FIELDS, type GitOpField } from "../lib/gitOps";
import { cn } from "../lib/utils";

export function GitOpProposalCard({
  gitOp,
  branches,
  projectId,
  onRan,
  onDismiss,
}: {
  gitOp: GitOpRequest;
  branches: string[];
  projectId: string | undefined;
  onRan: (message: string) => void;
  onDismiss: () => void;
}) {
  const meta = gitOpMeta(gitOp.kind);
  const destructive = DESTRUCTIVE_GIT_OPS.has(gitOp.kind);
  const [f, setF] = useState<Partial<Record<GitOpField, string>>>(() => {
    const init: Partial<Record<GitOpField, string>> = {};
    for (const field of meta.fields) {
      const v = gitOp[field];
      if (typeof v === "string") init[field] = v;
    }
    return init;
  });
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const target = (f.branch ?? "").trim();
  const confirmOk = !destructive || (target !== "" && confirmation === target); // exact, case-sensitive
  const set = (k: GitOpField, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function run() {
    if (busy || !confirmOk) return;
    setBusy(true);
    setErr(null);
    const payload: Record<string, string> = {};
    for (const field of meta.fields) {
      const v = (f[field] ?? "").trim();
      if (v) payload[field] = v;
    }
    try {
      const res = await runGitOp({
        kind: gitOp.kind,
        ...(projectId ? { projectId } : {}),
        ...payload,
        ...(destructive ? { confirmation } : {}),
      } as GitOpRequest);
      onRan(res.message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Operation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("rounded-xl border bg-card p-4", destructive ? "border-red-500/40" : "border-primary/30")}>
      <div className="mb-1 flex items-center gap-2">
        <Wrench className={cn("h-4 w-4", destructive ? "text-red-500" : "text-primary")} />
        <span className="font-semibold">{meta.label}</span>
        <span
          className={cn(
            "ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            destructive ? "border-red-500/30 bg-red-500/10 text-red-500" : "border-primary/30 bg-primary/10 text-primary"
          )}
        >
          {destructive ? "Destructive op" : "Proposed op"}
        </span>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{meta.desc}</p>

      {meta.fields.length > 0 && (
        <div className="mb-3 space-y-2">
          {meta.fields.map((field) =>
            field === "message" ? (
              <textarea
                key={field}
                value={f[field] ?? ""}
                onChange={(e) => set(field, e.target.value)}
                rows={2}
                placeholder={LABELS[field]}
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            ) : (
              <input
                key={field}
                value={f[field] ?? ""}
                onChange={(e) => set(field, e.target.value)}
                placeholder={LABELS[field]}
                list={BRANCH_FIELDS.has(field) ? "gitop-branches" : undefined}
                spellCheck={false}
                autoComplete="off"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
              />
            )
          )}
          <datalist id="gitop-branches">
            {branches.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
      )}

      {destructive && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/5 p-3">
          <p className="mb-2 flex items-start gap-1.5 text-xs font-medium text-red-500">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            This can&apos;t be undone. Type{" "}
            {target ? <code className="rounded bg-red-500/10 px-1 font-mono">{target}</code> : "(enter a branch above)"} to confirm.
          </p>
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder="Type the branch name to confirm"
            spellCheck={false}
            autoComplete="off"
            className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none focus:border-red-500"
          />
        </div>
      )}

      {err && (
        <p className="mb-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{err}</span>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void run()}
          disabled={busy || !confirmOk}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium text-white transition-colors disabled:opacity-50",
            destructive ? "bg-red-600 hover:bg-red-700" : "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
          Authorize &amp; run
        </button>
        <button
          onClick={onDismiss}
          disabled={busy}
          className="inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <X className="h-4 w-4" /> Dismiss
        </button>
      </div>
    </div>
  );
}
