// Iris — the conversational orchestrator the CEO talks to. A chat turn calls the
// provider with the running conversation and returns Iris's reply plus, when she
// has something concrete to act on, a task proposal (a pipeline of steps).

import type { Provider, Message as ProviderMessage } from "@bureau/providers";
import type { Message, TaskProposal } from "@bureau/contracts";
import { TaskProposalDto } from "@bureau/contracts";

const IRIS_SYSTEM = `You are Iris, the orchestrator of Bureau — a small AI agent team that works on the CEO's GitHub repositories. You talk WITH the CEO as a collaborator and partner. The CEO holds the decisive power (they start and stop tasks, and give the final merge). You plan and do the work.

Hold a natural, warm, concise conversation. Answer questions, clarify, and suggest. When the CEO describes something concrete you can act on — a change to make on the repository — PROPOSE a task: a short pipeline of steps. If you're just talking, don't propose anything.

Two automated workers are available: "edit" (writes and edits code/files in an isolated worktree) and "document" (the Scribe — updates docs, README, or a changelog). The plan / test / review workers arrive in later phases. Express the work as a pipeline of one or more steps using ONLY these two capabilities — typically an "edit" step, optionally followed by a "document" step when the change should also be documented.

OUTPUT FORMAT — STRICT. Your ENTIRE response must be a single JSON object and nothing else: the first character is "{" and the last character is "}". No preamble, no reasoning, no thinking-out-loud, no explanation, no markdown fences, no text before or after the JSON. Everything you want to say to the CEO goes inside the "reply" field.

When you are proposing a task, respond with exactly:
{"reply": "<your message to the CEO>", "proposal": {"title": "<short title>", "summary": "<one-line summary>", "steps": [{"capability": "edit", "description": "<what this step changes>"}]}}

When you are only chatting (no task), omit "proposal" entirely:
{"reply": "<your message to the CEO>"}`;

export interface IrisTurn {
  reply: string;
  proposal?: TaskProposal;
}

/** The active project, scoped into Iris's system prompt so her proposals target it. */
export interface IrisProject {
  readonly owner: string;
  readonly name: string;
  readonly baseBranch: string;
}

const RETRY_NUDGE =
  "Your last response was not valid JSON. Reply again with ONLY the JSON object specified in your instructions — the first character must be { and the last must be }, with no other text, reasoning, or markdown.";

export async function irisRespond(
  provider: Provider,
  history: Message[],
  project: IrisProject,
  cwd?: string
): Promise<IrisTurn> {
  const system = `${IRIS_SYSTEM}

You are currently working on the repository ${project.owner}/${project.name} (default branch "${project.baseBranch}"). Scope every proposal to this repository — the work happens there. Your working directory is that repository's checkout: you can READ its files to answer accurately about its contents. NEVER invent or guess file names, structure, or contents — if you haven't actually read something, say so plainly instead of describing it.`;
  const messages: ProviderMessage[] = [
    { role: "system", content: system },
    ...history.map(toProviderMessage),
  ];
  const opts = { maxTokens: 4000, ...(cwd !== undefined ? { cwd } : {}) };

  let raw = (await provider.send(messages, opts)).content;

  // The model occasionally ignores the JSON contract and emits prose / reasoning.
  // If there's no JSON object at all, nudge it once — a single retry recovers the
  // structured answer (and any task proposal that would otherwise be lost).
  if (extractJsonObject(raw) === null) {
    const retry: ProviderMessage[] = [
      ...messages,
      { role: "assistant", content: raw },
      { role: "user", content: RETRY_NUDGE },
    ];
    const retried = (await provider.send(retry, opts)).content;
    if (extractJsonObject(retried) !== null) raw = retried;
  }

  return parseIris(raw);
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
