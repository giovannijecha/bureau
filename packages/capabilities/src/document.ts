// The `document` capability (Scribe) — an agentic worker that updates docs and the
// changelog for a change. Like `edit`, it edits the worktree files directly
// (confined to it); the engine captures the diff. Runs as a later step in a
// pipeline, so the worktree already holds the code change it documents.

import type { Provider } from "@bureau/providers";
import type { Capability, CapabilityInput, CapabilityOutput } from "./capability.js";
import { runAgenticFileWorker } from "./edit.js";

const DOCUMENT_SYSTEM = `You are Bureau's "document" worker (the Scribe). The repository is checked out in your working directory and may already contain a code change from an earlier step. Update the project's documentation to reflect what was asked — READMEs, docs/, a CHANGELOG, or inline comments as appropriate — by editing the files DIRECTLY with your tools.

Rules:
- Stay inside the working directory. Do NOT run git, do NOT commit or push.
- Only touch documentation; do not change code behaviour. Keep it concise and accurate.
- When done, reply with ONE short line summarizing what you documented.`;

export interface DocumentCapabilityDeps {
  readonly provider: Provider;
}

export class DocumentCapability implements Capability {
  readonly kind = "document" as const;
  private readonly provider: Provider;

  constructor(deps: DocumentCapabilityDeps) {
    this.provider = deps.provider;
  }

  execute(input: CapabilityInput): Promise<CapabilityOutput> {
    return runAgenticFileWorker(this.provider, input, DOCUMENT_SYSTEM);
  }
}
