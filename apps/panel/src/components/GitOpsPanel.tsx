"use client";

// CEO-authorized git history/admin operations (squash, force-push, branch & tag admin).
// Destructive ops require typing the exact target branch to confirm — and the engine
// re-validates that confirmation server-side (case-sensitive). Execution is argv-only.

import { useState } from "react";
import { Wrench, AlertTriangle, Loader2, CheckCircle2 } from "lucide-react";
import type { GitOpKind, GitOpRequest } from "@bureau/contracts";
import { DESTRUCTIVE_GIT_OPS } from "@bureau/contracts";
import { runGitOp } from "../lib/api";
import { GIT_OPS as OPS, GIT_OP_FIELD_LABELS as LABELS, BRANCH_FIELDS, type GitOpField as Field } from "../lib/gitOps";
import { Dropdown } from "./Dropdown";
import { cn } from "../lib/utils";

export function GitOpsPanel({ branches, projectId, onDone }: { branches: string[]; projectId: string | undefined; onDone: () => void }) {
  const [kind, setKind] = useState<GitOpKind>("squash_all");
  const [f, setF] = useState<Partial<Record<Field, string>>>({});
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const op = OPS.find((o) => o.kind === kind)!;
  const destructive = DESTRUCTIVE_GIT_OPS.has(kind);
  const target = (f.branch ?? "").trim();
  const confirmOk = !destructive || (target !== "" && confirmation === target); // exact, case-sensitive
  const set = (k: Field, v: string) => setF((p) => ({ ...p, [k]: v }));

  async function run() {
    if (busy || !confirmOk) return;
    setBusy(true);
    setMsg(null);
    const payload: Record<string, string> = {};
    for (const field of op.fields) {
      const v = (f[field] ?? "").trim();
      if (v) payload[field] = v;
    }
    try {
      const res = await runGitOp({
        kind,
        ...(projectId ? { projectId } : {}),
        ...payload,
        ...(destructive ? { confirmation } : {}),
      } as GitOpRequest);
      setMsg({ ok: res.ok, text: res.message });
      setF({});
      setConfirmation("");
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Operation failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Wrench className="h-4 w-4 shrink-0 text-primary" />
        <span className="font-semibold">Repository operations</span>
        <span className="text-xs text-muted-foreground">— git admin, with your authorization</span>
      </div>
      <div className="space-y-3 p-4">
        {/* Operation picker (custom dropdown — no native <select>) */}
        <Dropdown
          value={kind}
          options={OPS.map((o) => ({ value: o.kind, label: o.label, hint: o.desc }))}
          onChange={(k) => {
            setKind(k);
            setConfirmation("");
            setMsg(null);
          }}
          className="w-full"
          buttonClassName="h-9 w-full"
        />
        <p className="text-xs text-muted-foreground">{op.desc}</p>

        {/* Per-operation inputs */}
        {op.fields.map((field) =>
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
              list={BRANCH_FIELDS.has(field) ? "git-branches" : undefined}
              spellCheck={false}
              autoComplete="off"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            />
          )
        )}
        <datalist id="git-branches">
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>

        {/* Destructive confirmation */}
        {destructive && (
          <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3">
            <p className="mb-2 flex items-start gap-1.5 text-xs font-medium text-red-500">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              This cannot be undone. Type the branch name{" "}
              {target ? (
                <code className="rounded bg-red-500/10 px-1 font-mono">{target}</code>
              ) : (
                "(enter a branch above)"
              )}{" "}
              to confirm.
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

        {msg && (
          <p className={cn("flex items-start gap-1.5 text-xs", msg.ok ? "text-green-500" : "text-destructive")}>
            {msg.ok ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />}
            <span>{msg.text}</span>
          </p>
        )}

        <button
          onClick={() => void run()}
          disabled={busy || !confirmOk}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-sm font-medium text-white transition-colors disabled:opacity-50",
            destructive ? "bg-red-600 hover:bg-red-700" : "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
          {destructive ? "Authorize & run" : "Run"}
        </button>
      </div>
    </div>
  );
}
