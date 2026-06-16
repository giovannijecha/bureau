"use client";

// A commit's full detail in an overlay: subject + author + date, the changed-file
// list with +/- stats, and the unified patch (via the shared DiffView). Opened from
// the Commits tab and from a file's history. Read-only.

import { useEffect, useState } from "react";
import { X, GitCommit, ExternalLink, Loader2, FileText } from "lucide-react";
import type { CommitDetail } from "@bureau/contracts";
import { getCommit } from "../lib/api";
import { DiffView } from "./DiffView";
import { relativeTime, cn } from "../lib/utils";

export function CommitDetailView({
  projectId,
  hash,
  repoSlug,
  onClose,
}: {
  projectId: string | undefined;
  hash: string;
  repoSlug: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setErr(null);
    getCommit(projectId, hash)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : "Couldn't load this commit."));
    return () => {
      alive = false;
    };
  }, [projectId, hash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8" onClick={onClose}>
      <div
        className="mt-4 w-full max-w-4xl overflow-hidden rounded-xl border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <GitCommit className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug">{detail ? detail.subject : "Commit"}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {detail && (
                <>
                  <span className="font-medium text-foreground/80">{detail.author}</span>
                  <span>committed {relativeTime(detail.date)}</span>
                </>
              )}
              <code className="font-mono text-primary">{hash}</code>
            </p>
          </div>
          {repoSlug && (
            <a
              href={`https://github.com/${repoSlug}/commit/${hash}`}
              target="_blank"
              rel="noreferrer"
              title="Open on GitHub"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {err ? (
          <p className="px-5 py-10 text-center text-sm text-destructive">{err}</p>
        ) : !detail ? (
          <p className="flex items-center justify-center gap-2 px-5 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading commit…
          </p>
        ) : (
          <div className="max-h-[72vh] overflow-y-auto">
            {detail.body && (
              <pre className="whitespace-pre-wrap border-b px-5 py-3 font-sans text-xs leading-relaxed text-muted-foreground">{detail.body}</pre>
            )}
            {/* Changed-file summary */}
            {detail.files.length > 0 && (
              <div className="border-b">
                <div className="px-5 py-2 text-xs text-muted-foreground">
                  {detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed
                </div>
                <ul className="divide-y border-t">
                  {detail.files.map((f) => (
                    <li key={f.path} className="flex items-center gap-2.5 px-5 py-1.5 text-xs">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <code className="min-w-0 flex-1 truncate font-mono">{f.path}</code>
                      {f.binary ? (
                        <span className="shrink-0 text-muted-foreground">binary</span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-2 font-medium tabular-nums">
                          <span className="text-green-600 dark:text-green-400">+{f.additions}</span>
                          <span className="text-red-500 dark:text-red-400">−{f.deletions}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detail.truncated && (
              <p className={cn("border-b bg-amber-500/10 px-5 py-1.5 text-xs text-amber-600 dark:text-amber-400")}>
                Patch truncated — this commit is too large to show in full.
              </p>
            )}
            <div className="p-3">
              <div className="overflow-hidden rounded-lg border">
                <DiffView diff={detail.patch} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
