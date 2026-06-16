"use client";

// The "Code" tab — a GitHub-style codebase browser: a branch dropdown, a "go to file"
// fuzzy finder, a breadcrumb, and a full-width file LIST where each row also shows the
// latest commit that touched it. Click a folder to navigate, a file to open a full-width
// viewer (with per-file History), the rendered README below the list at the repo root,
// or a commit message to open that commit's diff. All read-only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, FileText, ChevronRight, ChevronLeft, Loader2, GitBranch, BookOpen, FileCode2, Search, History, GitCommit } from "lucide-react";
import type { GitFileEntry, EntryCommit, RepoCommit } from "@bureau/contracts";
import { getGitTree, getGitShow, getTreeCommits, getFiles, getFileHistory } from "../lib/api";
import { Dropdown } from "./Dropdown";
import { Markdown } from "./Markdown";
import { CommitDetailView } from "./CommitDetailView";
import { cn, relativeTime } from "../lib/utils";

const README_RE = /^readme(\.md|\.markdown|\.txt)?$/i;

/** Is `q` a subsequence of `s` (the fuzzy fallback for the file finder)? */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

/** Rank file paths for the "go to file" finder: basename-prefix beats basename-substring
 *  beats path-substring beats fuzzy subsequence; ties break on shorter/alphabetical. */
function matchFiles(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { p: string; score: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    const baseIdx = base.indexOf(q);
    let score: number | null = null;
    if (baseIdx === 0) score = 0;
    else if (baseIdx > 0) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (isSubsequence(q, lower)) score = 3;
    if (score !== null) scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || a.p.length - b.p.length || a.p.localeCompare(b.p));
  return scored.slice(0, 50).map((s) => s.p);
}

export function GitCodeBrowser({
  projectId,
  branches,
  defaultBranch,
  repoName,
  repoSlug,
}: {
  projectId: string | undefined;
  branches: string[];
  defaultBranch: string;
  repoName: string;
  repoSlug: string;
}) {
  const [ref, setRef] = useState(defaultBranch);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<GitFileEntry[] | null>(null);
  const [commits, setCommits] = useState<Map<string, EntryCommit>>(new Map());
  const [file, setFile] = useState<{ path: string; content: string; truncated: boolean } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [readme, setReadme] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // "Go to file" finder — file list is lazy-loaded once per ref and cached.
  const [finderOpen, setFinderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const fileListCache = useRef<{ ref: string; paths: string[] } | null>(null);
  const [allPaths, setAllPaths] = useState<string[]>([]);

  // Per-file history panel + the commit overlay.
  const [history, setHistory] = useState<RepoCommit[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);

  useEffect(() => setRef(defaultBranch), [defaultBranch]);

  const loadDir = useCallback(
    async (r: string, p: string) => {
      setEntries(null);
      setErr(null);
      setReadme(null);
      try {
        const t = await getGitTree(projectId, r, p);
        setEntries(t.entries);
        if (p === "") {
          const rm = t.entries.find((e) => e.type === "blob" && README_RE.test(e.name));
          if (rm) {
            try {
              const f = await getGitShow(projectId, r, rm.path);
              setReadme(f.content);
            } catch {
              /* ignore — README is optional */
            }
          }
        }
      } catch (e) {
        setEntries([]);
        setErr(e instanceof Error ? e.message : "Couldn't list files.");
      }
    },
    [projectId]
  );

  useEffect(() => {
    void loadDir(ref, path);
  }, [ref, path, loadDir]);

  // Latest-commit-per-entry — fetched in PARALLEL with the tree so the file list
  // renders instantly and the commit column fills in a moment later (GitHub-style).
  useEffect(() => {
    let alive = true;
    setCommits(new Map());
    getTreeCommits(projectId, ref, path)
      .then((res) => {
        if (alive) setCommits(new Map(res.commits.map((c) => [c.path, c])));
      })
      .catch(() => {
        /* best-effort — the list still works without the commit column */
      });
    return () => {
      alive = false;
    };
  }, [projectId, ref, path]);

  async function openFile(p: string) {
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (parent !== path) setPath(parent); // keep the breadcrumb correct for finder-opened files
    setShowHistory(false);
    setHistory(null);
    setLoadingFile(true);
    setErr(null);
    try {
      const f = await getGitShow(projectId, ref, p);
      setFile({ path: p, content: f.content, truncated: f.truncated });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't open file.");
    } finally {
      setLoadingFile(false);
    }
  }

  async function loadFinder() {
    if (fileListCache.current?.ref === ref) {
      setAllPaths(fileListCache.current.paths);
      return;
    }
    try {
      const res = await getFiles(projectId, ref);
      fileListCache.current = { ref, paths: res.paths };
      setAllPaths(res.paths);
    } catch {
      setAllPaths([]);
    }
  }

  async function toggleHistory() {
    if (!file) return;
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setShowHistory(true);
    if (history === null) {
      try {
        const h = await getFileHistory(projectId, ref, file.path);
        setHistory(h.commits);
      } catch {
        setHistory([]);
      }
    }
  }

  const matches = useMemo(() => matchFiles(allPaths, query), [allPaths, query]);
  const latestInDir = useMemo(() => {
    let best: EntryCommit | null = null;
    for (const c of commits.values()) if (!best || c.date > best.date) best = c;
    return best;
  }, [commits]);

  const crumbs = path === "" ? [] : path.split("/");
  const go = (p: string) => {
    setFile(null);
    setShowHistory(false);
    setHistory(null);
    setPath(p);
  };
  const branchOpts = (branches.includes(ref) ? branches : [ref, ...branches]).map((b) => ({ value: b, label: b }));

  return (
    <div className="space-y-4">
      {selectedCommit && (
        <CommitDetailView projectId={projectId} hash={selectedCommit} repoSlug={repoSlug} onClose={() => setSelectedCommit(null)} />
      )}

      {/* Toolbar: branch dropdown + go-to-file finder + breadcrumb */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Dropdown
          value={ref}
          options={branchOpts}
          onChange={(b) => {
            setFile(null);
            setPath("");
            setShowHistory(false);
            setHistory(null);
            setRef(b);
          }}
          leftIcon={<GitBranch className="h-3.5 w-3.5 text-muted-foreground" />}
          buttonClassName="font-medium"
        />

        {/* Go to file */}
        <div className="relative">
          <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setFinderOpen(true);
              }}
              onFocus={() => {
                setFinderOpen(true);
                void loadFinder();
              }}
              onBlur={() => setTimeout(() => setFinderOpen(false), 150)}
              onKeyDown={(e) => e.key === "Escape" && setFinderOpen(false)}
              placeholder="Go to file"
              className="w-40 bg-transparent text-sm outline-none placeholder:text-muted-foreground sm:w-56"
            />
          </div>
          {finderOpen && query.trim() !== "" && (
            <div className="absolute z-20 mt-1 max-h-72 w-[20rem] overflow-y-auto rounded-md border bg-popover p-1 shadow-lg">
              {matches.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matching files.</p>
              ) : (
                matches.map((p) => (
                  <button
                    key={p}
                    onMouseDown={(e) => {
                      e.preventDefault(); // fire before the input's onBlur closes the list
                      setQuery("");
                      setFinderOpen(false);
                      void openFile(p);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono">{p}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm">
          <button onClick={() => go("")} className="shrink-0 font-medium text-primary transition-colors hover:underline">
            {repoName}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <button onClick={() => go(crumbs.slice(0, i + 1).join("/"))} className="truncate transition-colors hover:underline">
                {c}
              </button>
            </span>
          ))}
          {file && (
            <span className="flex min-w-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium text-foreground">{file.path.split("/").pop()}</span>
            </span>
          )}
        </div>
      </div>

      {err && <p className="text-xs text-destructive">{err}</p>}

      {file ? (
        /* Full-width file viewer */
        <div className="space-y-3">
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <button onClick={() => setFile(null)} className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <ChevronLeft className="h-3.5 w-3.5" /> Back
              </button>
              <FileCode2 className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate font-mono text-xs text-muted-foreground">{file.path}</span>
              <button
                onClick={() => void toggleHistory()}
                className={cn(
                  "ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted/60",
                  showHistory ? "border-primary/40 text-foreground" : "text-muted-foreground"
                )}
              >
                <History className="h-3.5 w-3.5" /> History
              </button>
            </div>
            {file.truncated && (
              <p className="border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400">File truncated — too large to show fully.</p>
            )}
            <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed">{file.content || "(empty file)"}</pre>
          </div>

          {/* Per-file history */}
          {showHistory && (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
                <History className="h-4 w-4 text-muted-foreground" /> History — {file.path.split("/").pop()}
              </div>
              {history === null ? (
                <p className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
                </p>
              ) : history.length === 0 ? (
                <p className="p-5 text-sm text-muted-foreground">No history for this file.</p>
              ) : (
                <ul className="divide-y">
                  {history.map((c) => (
                    <li key={c.hash}>
                      <button
                        onClick={() => setSelectedCommit(c.hash)}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
                      >
                        <GitCommit className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm">{c.subject}</span>
                        <code className="shrink-0 font-mono text-xs text-primary">{c.hash}</code>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                          {c.author} · {c.date}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* File list (GitHub-style rows with a latest-commit column) */}
          <div className="overflow-hidden rounded-lg border bg-card">
            {/* Latest commit in this directory */}
            {latestInDir && (
              <button
                onClick={() => setSelectedCommit(latestInDir.hash)}
                className="flex w-full items-center gap-2.5 border-b bg-muted/30 px-4 py-2 text-left text-xs transition-colors hover:bg-muted/50"
              >
                <GitCommit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{latestInDir.subject}</span>
                <code className="shrink-0 font-mono text-primary">{latestInDir.hash}</code>
                <span className="shrink-0 text-muted-foreground">{relativeTime(latestInDir.date)}</span>
              </button>
            )}
            {path !== "" && (
              <button
                onClick={() => go(crumbs.slice(0, -1).join("/"))}
                className="flex w-full items-center gap-3 border-b px-4 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50"
              >
                <ChevronLeft className="h-4 w-4 shrink-0" /> ..
              </button>
            )}
            {entries === null ? (
              <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            ) : loadingFile ? (
              <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Opening…
              </p>
            ) : entries.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">This directory is empty.</p>
            ) : (
              <div className="divide-y">
                {entries.map((e) => {
                  const c = commits.get(e.path);
                  return (
                    <div key={e.path} className="flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-muted/50">
                      <button
                        onClick={() => (e.type === "tree" ? go(e.path) : void openFile(e.path))}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        {e.type === "tree" ? (
                          <Folder className="h-4 w-4 shrink-0 text-blue-400" />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{e.name}</span>
                      </button>
                      {c && (
                        <button
                          onClick={() => setSelectedCommit(c.hash)}
                          title={c.subject}
                          className="hidden min-w-0 max-w-[45%] items-center gap-3 text-xs text-muted-foreground transition-colors hover:text-foreground sm:flex"
                        >
                          <span className="min-w-0 truncate">{c.subject}</span>
                          <span className="shrink-0 whitespace-nowrap">{relativeTime(c.date)}</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* README, rendered below the file list at root (GitHub-style) */}
          {path === "" && readme && (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-muted-foreground" /> README
              </div>
              <div className="px-5 py-4">
                <Markdown source={readme} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
