// Iris — the conversational orchestrator the CEO talks to. A chat turn calls the
// provider with the running conversation and returns Iris's reply plus, when she
// has something concrete to act on, a task proposal (a pipeline of steps).

import { dirname } from "node:path";
import type { Provider, Message as ProviderMessage } from "@bureau/providers";
import type { Message, TaskProposal, GitOpRequest } from "@bureau/contracts";
import { TaskProposalDto, GitOpRequestDto } from "@bureau/contracts";

const IRIS_SYSTEM = `You are Iris, the orchestrator of Bureau — a small AI agent team that works on the CEO's GitHub repositories. You talk WITH the CEO as a collaborator and partner. The CEO holds the decisive power (they start and stop tasks, and give the final merge). You plan and do the work.

Hold a natural, warm, concise conversation. Answer questions, clarify, and suggest. When the CEO describes something concrete you can act on — a CHANGE to make on the repository — PROPOSE a task: a short pipeline of steps that produces that change (always including an "edit" step). If you're just talking, don't propose anything. For pure inspection or verification (checking the repo state, confirming a cleanup, no file change to make), just answer in chat — you can READ the repo — or propose a read-only terminal command; do NOT create a review-only or plan-only task for it.

Six automated workers are available: "plan" (the Planner — read-only; lays out a concrete implementation plan the edit then follows), "research" (the Researcher — read-only; investigates the codebase AND the web/official docs and returns a grounded findings brief — for when a change needs external context or discovery in an unfamiliar area before planning/editing), "edit" (writes, edits, DELETES, and renames code/files in an isolated worktree), "document" (the Scribe — updates docs, README, or a changelog), "review" (the Reviewer — read-only; inspects the resulting change and flags issues before the CEO sees it), and "test" (the Tester — RUNS the project's configured test suite in the worktree and reports pass/fail; ADVISORY, it never merges). Express the work as a pipeline of one or more steps using ONLY these capabilities — typically an "edit" step; for a NON-TRIVIAL change you may lead with a "plan" step (and, only when the approach is genuinely unknown or needs external/library research, a "research" step BEFORE the plan — don't add it for routine work), and/or add a "document" step, a final "review" step, and a "test" step. Order matters: "research" and "plan" come FIRST (research before plan), and "test" / "review" / "document" come AFTER the edit they cover. Only propose a "test" step when the project HAS a test command configured (stated below). For a simple change, a single "edit" step is best — don't over-engineer the pipeline.

ANY change to the repository — creating, editing, DELETING, or renaming files — MUST go through a TASK: the edit worker makes the change in an isolated worktree, the CEO reviews the diff, and only the final confirm-merge lands it (the sole security gate). NEVER tell the CEO to run \`git add\`/\`git commit\`/\`git push\`/\`git rm\`/\`git checkout -b\` by hand, and never make a repo change in the terminal — that bypasses the review-and-merge flow.

The CEO also has an embedded Bureau terminal, for READ-ONLY inspection and genuine one-offs that DON'T change the repo. You MAY include such a command as a fenced \`\`\`bash code block inside your "reply" (e.g. \`git status\`, \`git log --oneline --graph -20\`, \`git branch -a\`, \`ls\`, \`cat path\`) — the CEO runs it with one click and you'll see its output next turn (provided as "Recent Bureau-terminal output"). You NEVER run commands yourself. Do NOT propose commands that mutate the repo or its history (commit/push/rm/checkout/merge). To delete leftover bureau/task-* branches, point the CEO to Git → "Clean up branches" (or the per-branch trash), not a manual push. And for git HISTORY or BRANCH/TAG ADMIN operations the task/edit flow can't express — squashing commits, force-pushing, resetting a branch, creating/renaming/deleting a branch, tagging, fetching — do NOT hand the CEO raw git commands and do NOT send them off to another screen: PROPOSE the operation INLINE via the "gitOp" field (see OUTPUT FORMAT). The CEO authorizes it with one click right here in chat and Bureau runs it argv-only WITH their authorization; the destructive ones (squash, force-push, reset, delete-branch) additionally ask the CEO to type the branch name to confirm. In your "reply", say plainly what the operation will do and why. The aim is that the CEO does everything by talking to you — never sent elsewhere to run things by hand. Propose only ONE thing per turn — a task OR a gitOp.

OUTPUT FORMAT — STRICT. Your ENTIRE response must be a single JSON object and nothing else: the first character is "{" and the last character is "}". No preamble, no reasoning, no thinking-out-loud, no explanation, no markdown fences, no text before or after the JSON. Everything you want to say to the CEO goes inside the "reply" field.

When you are proposing a task, respond with exactly:
{"reply": "<your message to the CEO>", "proposal": {"title": "<short title>", "summary": "<one-line summary>", "context": "<the decided brief — see below; omit only for a trivial self-evident change>", "steps": [{"capability": "edit", "description": "<what this step changes>"}]}}

CRITICAL — the workers see ONLY this proposal, never our conversation, the research, or System Memory. Whatever you decided WITH the CEO must be written DOWN here or it is LOST, and the worker will fall back to generic guesses. So:
- "context" is the brief the workers build to. When ANY real discussion, research, or design decision preceded the task, fill it concretely: the chosen approach/architecture, the specific stack/libraries/modules to use, the key facts/grounding (distill the relevant research findings — don't assume the worker can read them), and an EXPLICIT out-of-scope / "do NOT add" list (e.g. technologies we rejected). Be specific and self-contained; this is the workers' single source of truth.
- Each step "description" must be SPECIFIC and self-contained too — name the actual files/modules/stack, not "scaffold the skeleton" or "implement the change". A worker reading only the description + context should know exactly what to build.
- Omit "context" only for a trivial, self-evident one-step change where the description says it all.

When you are proposing a git branch/tag/history operation, respond with exactly:
{"reply": "<your message to the CEO>", "gitOp": {"kind": "<kind>", <params>}}
where "kind" and its params are ONE of:
- "create_branch": {"name": "<new-branch>", "base": "<optional base ref, e.g. main>"}
- "rename_branch": {"from": "<branch>", "to": "<new-name>"}
- "delete_branch": {"branch": "<branch>"}
- "tag": {"name": "<tag>", "message": "<optional annotation>"}
- "squash_all": {"branch": "<branch>", "message": "<new single commit message>"}
- "force_push": {"branch": "<branch>"}
- "reset_hard": {"branch": "<branch>", "ref": "<reset-to ref, e.g. origin/main>"}
- "fetch": {}
NEVER set "confirmation" or "projectId" — the panel and the CEO handle those. Use a gitOp ONLY for branch/tag/history admin, NEVER to change file contents (a content change is ALWAYS a task).

When you are only chatting (no action), omit both "proposal" and "gitOp":
{"reply": "<your message to the CEO>"}`;

export interface IrisTurn {
  reply: string;
  proposal?: TaskProposal;
  /** A branch/tag/history operation Iris proposes — the CEO authorizes it inline. */
  gitOp?: GitOpRequest;
  /** Token spend for this turn (summed across the send + any JSON-retry), for usage/cost. */
  usage?: { inputTokens: number; outputTokens: number; model: string };
}

/** The active project, scoped into Iris's system prompt so her proposals target it. */
export interface IrisProject {
  readonly owner: string;
  readonly name: string;
  readonly baseBranch: string;
  /** Whether a test command is configured — gates whether Iris proposes a test step. */
  readonly hasTests: boolean;
}

const RETRY_NUDGE =
  "Your last response was not valid JSON. Reply again with ONLY the JSON object specified in your instructions — the first character must be { and the last must be }, with no other text, reasoning, or markdown.";

/** Absolute cap on a single interactive Iris chat turn (the panel holds the HTTP request open
 *  for the whole turn). Tighter than the 60-min worker ceiling so a runaway turn fails fast
 *  instead of leaving the spinner up for an hour. The 5-min idle watchdog still bounds a hang. */
const CHAT_CEILING_MS = Number(process.env.BUREAU_CHAT_TIMEOUT) || 360_000; // 6 min

export async function irisRespond(
  provider: Provider,
  history: Message[],
  project: IrisProject,
  cwd?: string,
  /** A read-only snapshot of the repo's git state (branches, recent commits) so
   *  Iris can answer about history/branches without running git (she has no shell). */
  repoContext?: string,
  /** Image files the CEO attached to the latest message — saved on disk so the
   *  agent can VIEW them with its Read tool. */
  attachmentImages?: readonly { name: string; path: string }[],
  /** Which model to run the chat turn on (engine-resolved 'iris' scope); falls back to
   *  the provider default when unset. */
  modelOverride?: string,
  /** Called with a compact summary each time Iris invokes a tool during the turn (e.g.
   *  "Read src/auth.ts") — lets the engine stream live "what Iris is doing" activity. */
  onActivity?: (summary: string) => void,
  /** Extra directories Iris's READ-only tools may reach beyond her repo cwd — the System
   *  Memory vault, so she can open a past task's journal (research findings) on demand. */
  extraReadDirs?: readonly string[],
  /** Reasoning effort for the chat turn (engine-resolved 'iris' scope); omitted ⇒ default. */
  effortOverride?: "low" | "medium" | "high" | "xhigh"
): Promise<IrisTurn> {
  // Images can't be inlined as text — tell Iris where they are so she Reads (views) them.
  const imgNote =
    attachmentImages && attachmentImages.length > 0
      ? `\n\nThe CEO attached ${attachmentImages.length} image(s) to their latest message. Use your Read tool to VIEW each one (the Read tool renders images visually), then take what you actually see into account in your reply:\n${attachmentImages.map((a) => `- ${a.path}${a.name ? ` (${a.name})` : ""}`).join("\n")}`
      : "";
  // The Bureau terminal runs the host shell — tell Iris which, so a proposed command
  // uses compatible syntax (Windows PowerShell rejects `&&`).
  const shellNote =
    process.platform === "win32"
      ? "\n\nThe Bureau terminal runs Windows PowerShell. When you propose a terminal command, use PowerShell syntax — chain commands with `;` (semicolon), NOT `&&` (Windows PowerShell rejects `&&`). Keep proposed commands to ONE simple thing where you can."
      : "";
  const system = `${IRIS_SYSTEM}

You are currently working on the repository ${project.owner}/${project.name} (default branch "${project.baseBranch}"). Scope every proposal to this repository — the work happens there. Your working directory is that repository's checkout: you can READ its files to answer accurately about its contents. NEVER invent or guess file names, structure, or contents — if you haven't actually read something, say so plainly instead of describing it. ${project.hasTests ? 'This project HAS a configured test suite — you may add a final "test" step after the edit.' : 'This project has NO test command configured — do NOT propose a "test" step (it would just skip).'}${repoContext ? `\n\n${repoContext}` : ""}${shellNote}${imgNote}`;
  const messages: ProviderMessage[] = [
    { role: "system", content: system },
    ...history.map(toProviderMessage),
  ];
  // Let the CLI read dirs OUTSIDE the repo cwd: the attachments' dir (to view images) and
  // the System Memory vault (to Read a past task's journal). Read-only tools only.
  const dirs = new Set<string>();
  for (const a of attachmentImages ?? []) dirs.add(dirname(a.path));
  for (const d of extraReadDirs ?? []) dirs.add(d);
  const addDirs = dirs.size > 0 ? [...dirs] : undefined;
  const opts = {
    maxTokens: 4000,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(addDirs ? { addDirs } : {}),
    ...(modelOverride !== undefined ? { model: modelOverride } : {}),
    ...(effortOverride !== undefined ? { effort: effortOverride } : {}),
    ...(onActivity ? { onToolUse: onActivity } : {}),
    // A chat turn is INTERACTIVE (the panel holds the request open) — it must be snappy-or-fail,
    // not run to the 60-min worker ceiling. Cap it tighter; the 5-min idle watchdog still applies.
    ceilingMs: CHAT_CEILING_MS,
  };

  // Stream the turn so the agent's live tool calls (Read/Glob/…) surface via onToolUse
  // as Iris works; the streamed text is unused (we parse the final JSON from `content`).
  const first = await provider.stream(messages, () => {}, opts);
  let raw = first.content;
  let inputTokens = first.inputTokens;
  let outputTokens = first.outputTokens;
  let model = first.model ?? provider.name;

  // The model occasionally ignores the JSON contract and emits prose / reasoning.
  // If there's no JSON object at all, nudge it once — a single retry recovers the
  // structured answer (and any task proposal that would otherwise be lost).
  if (extractJsonObject(raw) === null) {
    const retry: ProviderMessage[] = [
      ...messages,
      { role: "assistant", content: raw },
      { role: "user", content: RETRY_NUDGE },
    ];
    const retried = await provider.send(retry, opts);
    inputTokens += retried.inputTokens;
    outputTokens += retried.outputTokens;
    model = retried.model ?? model;
    if (extractJsonObject(retried.content) !== null) raw = retried.content;
  }

  return { ...parseIris(raw), usage: { inputTokens, outputTokens, model } };
}

function toProviderMessage(m: Message): ProviderMessage {
  const role = m.role === "iris" ? "assistant" : m.role === "system" ? "system" : "user";
  return { role, content: m.content };
}

/** Parse Iris's raw response into a reply + optional proposal. Falls back to plain text. */
export function parseIris(raw: string): IrisTurn {
  const json = extractJsonObject(raw);
  if (json === null) return { reply: raw.trim() || "…" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { reply: raw.trim() || "…" };
  }
  const obj = parsed as { reply?: unknown; proposal?: unknown; gitOp?: unknown };
  const reply = typeof obj.reply === "string" && obj.reply.trim() ? obj.reply : raw.trim() || "…";
  // A task proposal takes precedence (one actionable thing per turn).
  const proposalResult = TaskProposalDto.safeParse(obj.proposal);
  if (proposalResult.success) return { reply, proposal: proposalResult.data };
  // A git-op proposal: strip any confirmation/projectId Iris shouldn't set — the panel
  // re-derives the project and the CEO supplies the destructive type-to-confirm itself.
  const gitOpResult = GitOpRequestDto.safeParse(obj.gitOp);
  if (gitOpResult.success) {
    const { confirmation: _c, projectId: _p, ...gitOp } = gitOpResult.data;
    return { reply, gitOp };
  }
  return { reply };
}

/** Slice the outermost {...} from a model reply that may wrap it in prose/markdown fences.
 *  Exported so other single-call workers (e.g. the memory curator) reuse the same extraction. */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}
