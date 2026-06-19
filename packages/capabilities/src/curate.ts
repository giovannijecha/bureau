// The memory "Archivist" — a single-call, READ-ONLY worker that keeps the System Memory
// vault tight, current, and non-contradictory so the orchestrator (Iris) stays on point.
//
// Unlike the pipeline capabilities (plan/edit/test/review/document/research) it is NOT a
// CapabilityKind and is NEVER registered: it runs OUTSIDE the Task state machine, invoked
// directly by the orchestrator. So canPush()/transition()/gates are never reached. It also
// runs tool-less — one completion over a digest of the vault — so it works on BOTH the
// claude CLI and the api-key provider, and it MUTATES nothing: it only PROPOSES a plan. The
// engine applies the CEO-approved subset deterministically (and reversibly, via archive/).

import type { Provider, Message, ProviderResponse } from "@bureau/providers";

export const CURATE_SYSTEM = `You are Bureau's memory Archivist. You are given an INDEX of the System Memory vault — the CEO's pinned notes plus finished-task journals (each carries a kind, path, date, repo, title, and a one-line excerpt). Your job is to keep the vault tight, current, and non-contradictory so Iris (the orchestrator) reasons from a clean memory.

Return ONLY a single JSON object — the first character must be "{" and the last "}", with no prose, no reasoning, no markdown fences:
{"summary": "<1-2 sentences on the vault's overall health>", "actions": [ <Action>, ... ]}

Each Action is exactly ONE of:
- AUDIT (advisory only — changes nothing): {"kind":"audit","paths":["<cited vault paths>"],"reason":"<what is stale / duplicated / contradictory, and why it matters>"}
- COMPACT (fold a cluster of OLD journals on the same topic into one digest): {"kind":"compact","paths":["<source journal paths>"],"reason":"<why these belong together and can be condensed>","digestTitle":"Digest: <topic> (<date range>)","digestBody":"<faithful markdown digest preserving each source's key outcome — do NOT invent outcomes>"}
- PROMOTE (turn a recurring/important decision into a durable pinned note): {"kind":"promote","paths":["<source path(s) it came from, if any>"],"reason":"<why it deserves to be pinned>","noteTitle":"<concise note title>","noteBody":"<the durable fact in markdown>"}
- PRUNE (archive a clearly superseded or obsolete entry): {"kind":"prune","paths":["<paths to archive>"],"reason":"<what supersedes it>"}

Rules:
- Cite EVERY action by exact vault path(s) taken from the index — never invent a path.
- Be CONSERVATIVE: when unsure, AUDIT-flag rather than prune. Never prune a pinned note unless something clearly supersedes it.
- COMPACT only OLD journals that are genuinely about the same topic/repo; keep the digest faithful.
- You PROPOSE; you never apply. The CEO reviews and approves each action.
- If the vault is already tidy, return {"summary":"<say it's tidy>","actions":[]}.`;

export function buildCuratePrompt(digest: string): string {
  return [
    "Current System Memory vault (newest first). Each line: [kind] path — (date, repo) title — excerpt",
    "",
    digest,
    "",
    "Produce the curation plan as specified — JSON only.",
  ].join("\n");
}

/** Run the Archivist over a vault digest. Returns the raw provider response (the caller
 *  extracts + validates the JSON plan and records usage). One call, no tools, no mutation. */
export function runCurator(
  provider: Provider,
  opts: { digest: string; model?: string; effort?: "low" | "medium" | "high" | "xhigh" }
): Promise<ProviderResponse> {
  const messages: Message[] = [
    { role: "system", content: CURATE_SYSTEM },
    { role: "user", content: buildCuratePrompt(opts.digest) },
  ];
  return provider.send(messages, {
    maxTokens: 4000,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  });
}
