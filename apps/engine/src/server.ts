// Bureau engine — persistent Node daemon. Wires the real adapters and starts
// the HTTP API + WebSocket hub. localhost only.
//
// Required env: BUREAU_REPO_OWNER, BUREAU_REPO_NAME, BUREAU_REPO_URL,
//               BUREAU_CANONICAL, BUREAU_WORKTREES
// Optional:     BUREAU_BASE_BRANCH (main), BUREAU_DB (./bureau.db), PORT (4319),
//               ANTHROPIC_API_KEY (else falls back to the `claude` CLI),
//               BUREAU_GIT_PATH, BUREAU_GH_PATH

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createDb, runMigrations, TaskRepo } from "@bureau/db";
import { CapabilityRegistry, EditCapability } from "@bureau/capabilities";
import {
  AnthropicProvider,
  ClaudeCliProvider,
  ApiKeyStrategy,
  CliDelegationStrategy,
  type Provider,
} from "@bureau/providers";
import { makeRunner } from "@bureau/vcs";
import type { WsEvent } from "@bureau/contracts";

import { Orchestrator } from "./orchestrator.js";
import { RealVcs, InMemoryMessageLog } from "./adapters.js";
import { WsHub } from "./ws.js";
import { createHttpServer } from "./http.js";
import type { EventSink } from "./ports.js";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function buildProvider(): Provider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey !== undefined && apiKey.trim().length > 0) {
    return new AnthropicProvider({
      authStrategy: ApiKeyStrategy.fromEnv("ANTHROPIC_API_KEY"),
      client: new Anthropic({ apiKey }),
    });
  }
  const strategy = new CliDelegationStrategy();
  if (!strategy.isAvailable()) {
    throw new Error("No provider available: set ANTHROPIC_API_KEY or install the `claude` CLI on PATH.");
  }
  return new ClaudeCliProvider({ authStrategy: strategy });
}

function main(): void {
  const config = {
    repoOwner: env("BUREAU_REPO_OWNER"),
    repoName: env("BUREAU_REPO_NAME"),
    baseBranch: env("BUREAU_BASE_BRANCH", "main"),
    worktreesDir: env("BUREAU_WORKTREES"),
  };
  const port = Number(env("PORT", "4319"));

  const db = createDb(env("BUREAU_DB", "./bureau.db"));
  runMigrations(db);
  const store = new TaskRepo(db);

  const provider = buildProvider();
  const capabilities = new CapabilityRegistry();
  capabilities.register(new EditCapability({ provider }));

  const runner = makeRunner({
    ...(process.env.BUREAU_GIT_PATH !== undefined ? { gitPath: process.env.BUREAU_GIT_PATH } : {}),
    ...(process.env.BUREAU_GH_PATH !== undefined ? { ghPath: process.env.BUREAU_GH_PATH } : {}),
  });
  const vcs = new RealVcs({
    repoOwner: config.repoOwner,
    repoName: config.repoName,
    repoUrl: env("BUREAU_REPO_URL"),
    canonicalPath: env("BUREAU_CANONICAL"),
    author: {
      name: env("BUREAU_AUTHOR_NAME", "Bureau"),
      email: env("BUREAU_AUTHOR_EMAIL", "bureau@localhost"),
    },
    runner,
  });

  const messages = new InMemoryMessageLog();

  // The orchestrator needs an EventSink, the WsHub needs the http server, and the
  // http server needs the orchestrator — so the sink forwards to the hub once it
  // exists.
  let hub: WsHub | undefined;
  const events: EventSink = { emit: (event: WsEvent) => hub?.emit(event) };

  const orchestrator = new Orchestrator({
    store,
    capabilities,
    provider,
    vcs,
    events,
    messages,
    config,
    ids: () => randomUUID(),
    clock: () => new Date().toISOString(),
  });

  const server = createHttpServer({ orchestrator, store, messages });
  hub = new WsHub(server);

  server.listen(port, () => {
    console.log(`Bureau engine listening on http://localhost:${port} (ws: /ws)`);
    console.log(`Repo: ${config.repoOwner}/${config.repoName} · worktrees: ${config.worktreesDir}`);
  });
}

main();
