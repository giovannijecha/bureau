import { z } from "zod";

// The Git console — a read-only view of the active project's repository (current
// branch, recent commits, branches), freshly synced from origin. No mutations:
// push/PR/merge stay behind the canPush() wall and the confirm-merge flow.

export const RepoCommitDto = z.object({
  hash: z.string(),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
});

export const GitInfoDto = z.object({
  projectId: z.string(),
  owner: z.string(),
  name: z.string(),
  baseBranch: z.string(),
  /** The clone's current branch, or null on a fresh/edge-case repo. */
  branch: z.string().nullable(),
  /** Whether a clone exists on disk yet (false → the repo hasn't been cloned). */
  cloned: z.boolean(),
  commits: z.array(RepoCommitDto),
  branches: z.array(z.string()),
});

export type RepoCommit = z.infer<typeof RepoCommitDto>;
export type GitInfo = z.infer<typeof GitInfoDto>;

// ── Read-only codebase browser (embedded-GitHub Git page) ───────────────────────

export const GitFileEntryDto = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["blob", "tree"]),
});

export const GitTreeDto = z.object({
  ref: z.string(),
  path: z.string(),
  entries: z.array(GitFileEntryDto),
  /** True when the repo has no commits yet (a freshly created, unborn-branch repo). The
   *  browser shows a "no commits yet" state instead of surfacing git's `ls-tree` error. */
  empty: z.boolean(),
});

export const GitFileContentDto = z.object({
  ref: z.string(),
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export type GitFileEntry = z.infer<typeof GitFileEntryDto>;
export type GitTree = z.infer<typeof GitTreeDto>;
export type GitFileContent = z.infer<typeof GitFileContentDto>;

// ── GitHub account connection (read-only; reuses the gh CLI auth) ────────────────

export const GithubAccountDto = z.object({
  connected: z.boolean(),
  login: z.string().optional(),
  name: z.string().nullable().optional(),
});

export type GithubAccount = z.infer<typeof GithubAccountDto>;

// ── Pull requests & issues (read-only, via gh) ──────────────────────────────────

export const PullRequestDto = z.object({
  number: z.number(),
  title: z.string(),
  author: z.string(),
  state: z.string(),
  url: z.string(),
  draft: z.boolean(),
});

export const IssueDto = z.object({
  number: z.number(),
  title: z.string(),
  author: z.string(),
  state: z.string(),
  url: z.string(),
});

export type PullRequest = z.infer<typeof PullRequestDto>;
export type Issue = z.infer<typeof IssueDto>;

// ── Per-file "latest commit" column (the code browser) ──────────────────────────

export const EntryCommitDto = z.object({
  path: z.string(),
  hash: z.string(),
  subject: z.string(),
  date: z.string(),
});

export const TreeCommitsDto = z.object({
  ref: z.string(),
  path: z.string(),
  commits: z.array(EntryCommitDto),
});

export type EntryCommit = z.infer<typeof EntryCommitDto>;
export type TreeCommits = z.infer<typeof TreeCommitsDto>;

// ── Commit detail (the diff viewer) ─────────────────────────────────────────────

export const CommitFileDto = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
});

export const CommitDetailDto = z.object({
  hash: z.string(),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
  body: z.string(),
  files: z.array(CommitFileDto),
  patch: z.string(),
  truncated: z.boolean(),
});

export type CommitFile = z.infer<typeof CommitFileDto>;
export type CommitDetail = z.infer<typeof CommitDetailDto>;

// ── "Go to file" finder + per-file history ──────────────────────────────────────

export const FileListDto = z.object({
  ref: z.string(),
  paths: z.array(z.string()),
  truncated: z.boolean(),
});

export const FileHistoryDto = z.object({
  ref: z.string(),
  path: z.string(),
  commits: z.array(RepoCommitDto),
});

export type FileList = z.infer<typeof FileListDto>;
export type FileHistory = z.infer<typeof FileHistoryDto>;
