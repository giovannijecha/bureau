"use client";

// A GitHub-style unified-diff renderer: a per-file collapsible list with +/- counts
// and a guttered, syntax-tinted body. Shared by the task review page (the branch diff)
// and the Git page's commit viewer (a single commit's patch) — one canonical renderer.

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { cn } from "../lib/utils";

interface DiffFile {
  path: string;
  lines: string[];
  added: number;
  removed: number;
  status: "added" | "removed" | "modified";
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) files.push(cur);
      // header is `diff --git a/PATH b/PATH`; take the path after the LAST " b/".
      const rest = line.slice("diff --git ".length);
      const idx = rest.lastIndexOf(" b/");
      cur = { path: idx >= 0 ? rest.slice(idx + 3) : rest, lines: [], added: 0, removed: 0, status: "modified" };
    }
    if (!cur) continue;
    if (line.startsWith("new file")) cur.status = "added";
    else if (line.startsWith("deleted file")) cur.status = "removed";
    cur.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) cur.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.removed++;
  }
  if (cur) files.push(cur);
  return files;
}

export function DiffView({ diff }: { diff: string }) {
  if (diff.trim() === "") return <p className="px-4 py-8 text-center text-sm text-muted-foreground">No changes.</p>;
  const files = parseDiff(diff);
  if (files.length === 0)
    return (
      <div className="p-3">
        <DiffLines lines={diff.split("\n")} />
      </div>
    );
  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div>
      <div className="flex items-center gap-2 border-b bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <span className="text-green-600 dark:text-green-400">+{totalAdded}</span>
        <span className="text-red-500 dark:text-red-400">−{totalRemoved}</span>
      </div>
      <div className="divide-y">
        {files.map((f, i) => (
          <FileDiff key={i} file={f} defaultOpen={files.length <= 3} />
        ))}
      </div>
    </div>
  );
}

const FILE_BADGE: Record<DiffFile["status"], string> = {
  added: "border-green-500/40 text-green-600 dark:text-green-400",
  removed: "border-red-500/40 text-red-500 dark:text-red-400",
  modified: "border-border text-muted-foreground",
};

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-muted/40">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <code className="truncate font-mono text-xs">{file.path}</code>
        <span className={cn("shrink-0 rounded border px-1.5 py-px text-[10px] font-medium capitalize", FILE_BADGE[file.status])}>{file.status}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] font-medium tabular-nums">
          <span className="text-green-600 dark:text-green-400">+{file.added}</span>
          <span className="text-red-500 dark:text-red-400">−{file.removed}</span>
        </span>
      </button>
      {open && (
        <div className="border-t px-3 pb-3 pt-1">
          <DiffLines lines={file.lines} />
        </div>
      )}
    </div>
  );
}

type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "add" | "del" | "ctx"; oldNo: number | null; newNo: number | null; text: string };

/** Parse a single file's diff lines into rows carrying old/new line numbers, so the
 *  rendered diff has a proper gutter (GitHub-style) instead of a raw code dump. */
function toRows(lines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of lines) {
    // The trailing "" from splitting a newline-terminated diff — not a real line.
    // (A genuine blank context line is " ", a single space, so it isn't skipped.)
    if (line === "") continue;
    // File-level headers are surfaced in the FileDiff header — don't repeat them.
    if (/^(diff --git |index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode|GIT binary patch)/.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    // Before any hunk there are no line numbers — surface a "Binary files … differ"
    // line as a plain marker, and drop any other pre-hunk stray (never number it).
    if (!inHunk) {
      if (line.startsWith("Binary files")) rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line.slice(1).trim() }); // "\ No newline at end of file"
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo++;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "ctx", oldNo, newNo, text });
      oldNo++;
      newNo++;
    }
  }
  return rows;
}

function DiffLines({ lines }: { lines: string[] }) {
  const rows = toRows(lines);
  return (
    <div className="max-h-[460px] overflow-y-auto rounded-md border bg-card font-mono text-xs leading-relaxed">
      {rows.map((r, i) => {
        if (r.kind === "hunk") {
          return (
            <div key={i} className="select-none whitespace-pre-wrap break-words bg-primary/5 px-3 py-1 text-[11px] text-muted-foreground">
              {r.text}
            </div>
          );
        }
        if (r.kind === "meta") {
          return (
            <div key={i} className="select-none px-3 py-0.5 text-[11px] italic text-muted-foreground/70">
              {r.text}
            </div>
          );
        }
        const tint =
          r.kind === "add"
            ? "bg-green-500/10 text-green-700 dark:text-green-300"
            : r.kind === "del"
              ? "bg-red-500/10 text-red-600 dark:text-red-300"
              : "text-foreground/80";
        const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
        // Grid (not flex) so a long line WRAPS in the content column instead of
        // overflowing/clipping; the row background spans the full width, and the
        // gutters stay aligned to the first wrapped line.
        return (
          <div key={i} className={cn("grid grid-cols-[2.75rem_2.75rem_1.25rem_minmax(0,1fr)]", tint)}>
            <span className="select-none px-1.5 text-right text-muted-foreground/40">{r.oldNo ?? ""}</span>
            <span className="select-none border-r px-1.5 text-right text-muted-foreground/40">{r.newNo ?? ""}</span>
            <span className={cn("select-none text-center", r.kind === "add" ? "text-green-600 dark:text-green-400" : r.kind === "del" ? "text-red-500 dark:text-red-400" : "text-transparent")}>
              {sign}
            </span>
            <span className="whitespace-pre-wrap break-words px-1.5">{r.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
