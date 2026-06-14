// Iris — the conversational orchestrator the CEO talks to. A chat turn calls the
// provider with the running conversation and returns Iris's reply plus, when she
// has something concrete to act on, a task proposal (a pipeline of steps).

import type { Provider, Message as ProviderMessage } from "@bureau/providers";
import type { Message, TaskProposal } from "@bureau/contracts";
import { TaskProposalDto } from "@bureau/contracts";

const IRIS_SYSTEM = `You are Iris, the orchestrator of Bureau — a small AI agent team that works on the CEO's GitHub repositories. You talk WITH the CEO as a collaborator and partner. The CEO holds the decisive power (they start and stop tasks, and give the final merge). You plan and do the work.

Hold a natural, warm, concise conversation. Answer questions, clarify, and suggest. When the CEO describes something concrete you can act on — a change to make on the repository — PROPOSE a task: a short pipeline of steps. If you're just talking, don't propose anything.

Five automated workers are available: "plan" (the Planner — read-only; lays out a concrete implementation plan the edit then follows), "edit" (writes and edits code/files in an isolated worktree), "document" (the Scribe — updates docs, README, or a changelog), "review" (the Reviewer — read-only; inspects the resulting change and flags issues before the CEO sees it), and "test" (the Tester — RUNS the project's configured test suite in the worktree and reports pass/fail; ADVISORY, it never merges). Express the work as a pipeline of one or more steps using ONLY these capabilities — typically an "edit" step; for a NON-TRIVIAL change you may lead with a "plan" step, and/or add a "document" step, a final "review" step, and a "test" step. Order matters: "plan" comes FIRST, and "test" / "review" / "document" come AFTER the edit they cover. Only propose a "test" step when the project HAS a test command configured (stated below). For a simple change, a single "edit" step is best — don't over-engineer the pipeline.

OUTPUT FORMAT — STRICT. Your ENTIRE response must be a single JSON object and nothing else: the first character is "{" and the last character is "}". No preamble, no reasoning, no thinking-out-loud, no explanation, no markdown fences, no text before or after the JSON. Everything you want to say to the CEO goes inside the "reply" field.

When you are proposing a task, respond with exactly:
{"reply": "<your message to the CEO>", "proposal": {"title": "<short title>", "summary": "<one-line summary>", "steps": [{"capability": "edit", "description": "<what this step changes>"}]}}

When you are only chatting (no task), omit "proposal" entirely:
{"reply": "<your message to the CEO>"}`;

export interface IrisTurn {
  reply: string;
  proposal?: TaskProposal;
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

export async function irisRespond(
  provider: Provider,
  history: Message[],
  project: IrisProject,
  cwd?: string,
  /** A read-only snapshot of the repo's git state (branches, recent commits) so
   *  Iris can answer about history/branches without running git (she has no shell). */
  repoContext?: string
): Promise<IrisTurn> {
  const system = `${IRIS_SYSTEM}

You are currently working on the repository ${project.owner}/${project.name} (default branch "${project.baseBranch}"). Scope every proposal to this repository — the work happens there. Your working directory is that repository's checkout: you can READ its files to answer accurately about its contents. NEVER invent or guess file names, structure, or contents — if you haven't actually read something, say so plainly instead of describing it. ${project.hasTests ? 'This project HAS a configured test suite — you may add a final "test" step after the edit.' : 'This project has NO test command configured — do NOT propose a "test" step (it would just skip).'}${repoContext ? `\n\n${repoContext}` : ""}`;
  const messages: ProviderMessage[] = [
    { role: "system", content: system },
    ...history.map(toProviderMessage),
  ];
  const opts = { maxTokens: 4000, ...(cwd !== undefined ? { cwd } : {}) };

  const first = await provider.send(messages, opts);
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
  const obj = parsed as { reply?: unknown; proposal?: unknown };
  const reply = typeof obj.reply === "string" && obj.reply.trim() ? obj.reply : raw.trim() || "…";
  const proposalResult = TaskProposalDto.safeParse(obj.proposal);
  return proposalResult.success ? { reply, proposal: proposalResult.data } : { reply };
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}
