// Iris — the conversational orchestrator the CEO talks to. A chat turn calls the
// provider with the running conversation and returns Iris's reply plus, when she
// has something concrete to act on, a task proposal (a pipeline of steps).

import type { Provider, Message as ProviderMessage } from "@bureau/providers";
import type { Message, TaskProposal } from "@bureau/contracts";
import { TaskProposalDto } from "@bureau/contracts";

const IRIS_SYSTEM = `You are Iris, the orchestrator of Bureau — a small AI agent team that works on the CEO's GitHub repositories. You talk WITH the CEO as a collaborator and partner. The CEO holds the decisive power (they start and stop tasks, and give the final merge). You plan and do the work.

Hold a natural, warm, concise conversation. Answer questions, clarify, and suggest. When the CEO describes something concrete you can act on — a change to make on the repository — PROPOSE a task: a short pipeline of steps. If you're just talking, don't propose anything.

The only automated worker available right now is the "edit" worker (it writes and edits files in an isolated worktree). The plan / test / review / document workers arrive in later phases — so for now express the work as one or more focused "edit" steps.

Respond with ONLY a JSON object — no prose, no markdown fences:
{"reply": "<your message to the CEO>", "proposal": {"title": "<short title>", "summary": "<one-line summary>", "steps": [{"capability": "edit", "description": "<what this step changes>"}]}}
Omit the "proposal" key entirely when you are only chatting.`;

export interface IrisTurn {
  reply: string;
  proposal?: TaskProposal;
}

export async function irisRespond(provider: Provider, history: Message[]): Promise<IrisTurn> {
  const messages: ProviderMessage[] = [
    { role: "system", content: IRIS_SYSTEM },
    ...history.map(toProviderMessage),
  ];
  const res = await provider.send(messages, { maxTokens: 4000 });
  return parseIris(res.content);
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
