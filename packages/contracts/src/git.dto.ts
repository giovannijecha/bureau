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
