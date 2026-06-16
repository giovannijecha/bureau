// Bureau engine — persistent Node daemon. Wires the real adapters and starts
// the HTTP API + WebSocket hub. localhost only.
//
// Projects: set BUREAU_PROJECTS (JSON array of {owner,name,url,baseBranch?}) plus
// BUREAU_REPOS_ROOT for multi-repo; or use the legacy single-repo env below.
//
// Required env (multi-repo): BUREAU_PROJECTS, BUREAU_REPOS_ROOT
// Required env (legacy single-repo): BUREAU_REPO_OWNER, BUREAU_REPO_NAME,
//               BUREAU_REPO_URL, BUREAU_CANONICAL, BUREAU_WORKTREES
// Optional:     BUREAU_BASE_BRANCH (main), BUREAU_DB (./bureau.db), PORT (4319),
//               ANTHROPIC_API_KEY (else falls back to the `claude` CLI),
//               BUREAU_AUTHOR_NAME, BUREAU_AUTHOR_EMAIL, BUREAU_GIT_PATH, BUREAU_GH_PATH

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createDb, runMigrations, TaskRepo, MessageRepo, ConversationRepo, UsageRepo, NotificationRepo } from "@bureau/db";
import { CapabilityRegistry, EditCapability, DocumentCapability, ReviewCapability, PlanCapability, ResearchCapability, TestCapability } from "@bureau/capabilities";
import {
  AnthropicProvider,
  ClaudeCliProvider,
  ApiKeyStrategy,
  CliDelegationStrategy,
  type Provider,
} from "@bureau/providers";
import { makeRunner, type CommitAuthor } from "@bureau/vcs";
import type { WsEvent } from "@bureau/contracts";

import { Orchestrator } from "./orchestrator.js";
import { ProjectRegistry, projectsFromJson, parseTestCommand, slug, type ProjectConfig } from "./projects.js";
import { RealVcs, DbMessageLog, DbConversationStore, VaultStore, DbUsage, DbNotifications } from "./adapters.js";
import { WsHub } from "./ws.js";
import { TerminalHub } from "./terminal.js";
import { createHttpServer } from "./http.js";
import { sameMachineOrigin } from "./ws-origin.js";
import type { EventSink, VcsPort } from "./ports.js";

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

/** Build the project registry from BUREAU_PROJECTS (JSON) or the legacy single-repo env. */
function buildRegistry(): ProjectRegistry {
  const json = process.env.BUREAU_PROJECTS;
  if (json !== undefined && json.trim().length > 0) {
    return new ProjectRegistry(projectsFromJson(json, env("BUREAU_REPOS_ROOT")));
  }
  const name = env("BUREAU_REPO_NAME");
  const owner = env("BUREAU_REPO_OWNER");
  // Optional: a test command as a JSON argv array, e.g. BUREAU_TEST_COMMAND='["npm","test"]'.
  const testRaw = process.env.BUREAU_TEST_COMMAND;
  let testCommand: readonly string[] | undefined;
  if (testRaw && testRaw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(testRaw);
    } catch {
      throw new Error('BUREAU_TEST_COMMAND must be a JSON array, e.g. ["npm","test"]');
    }
    testCommand = parseTestCommand(parsed, "BUREAU_TEST_COMMAND");
  }
  const project: ProjectConfig = {
    id: slug(`${owner}-${name}`),
    owner,
    name,
    url: env("BUREAU_REPO_URL"),
    baseBranch: env("BUREAU_BASE_BRANCH", "main"),
    canonicalPath: env("BUREAU_CANONICAL"),
    worktreesDir: env("BUREAU_WORKTREES"),
    ...(testCommand !== undefined ? { testCommand } : {}),
  };
  return new ProjectRegistry([project]);
}

async function main(): Promise<void> {
  // Auto-load a local .env (copy apps/engine/.env.example → .env). Env already in
  // the environment still wins / is used when there's no file.
  try {
    process.loadEnvFile();
  } catch {
    /* no .env file — configuration comes from the environment */
  }

  const port = Number(env("PORT", "4319"));

  const db = createDb(env("BUREAU_DB", "./bureau.db"));
  runMigrations(db);
  const store = new TaskRepo(db);

  const provider = buildProvider();
  const capabilities = new CapabilityRegistry();
  capabilities.register(new PlanCapability({ provider }));
  capabilities.register(new ResearchCapability({ provider }));
  capabilities.register(new EditCapability({ provider }));
  capabilities.register(new DocumentCapability({ provider }));
  capabilities.register(new ReviewCapability({ provider }));
  // The Tester runs the project's CONFIGURED test command (opt-in per project); with
  // none configured a test step just skips. The only worker that executes a command.
  capabilities.register(new TestCapability());

  const runner = makeRunner({
    ...(process.env.BUREAU_GIT_PATH !== undefined ? { gitPath: process.env.BUREAU_GIT_PATH } : {}),
    ...(process.env.BUREAU_GH_PATH !== undefined ? { ghPath: process.env.BUREAU_GH_PATH } : {}),
  });

  const author: CommitAuthor = {
    name: env("BUREAU_AUTHOR_NAME", "Bureau"),
    email: env("BUREAU_AUTHOR_EMAIL", "bureau@localhost"),
  };
  const projects = buildRegistry();

  // A VCS port bound to a specific project (its clone, owner/repo, and author).
  const vcsFor = (project: ProjectConfig): VcsPort =>
    new RealVcs({
      repoOwner: project.owner,
      repoName: project.name,
      repoUrl: project.url,
      canonicalPath: project.canonicalPath,
      baseBranch: project.baseBranch,
      author,
      runner,
    });

  const messages = new DbMessageLog(new MessageRepo(db));
  const conversations = new DbConversationStore(new ConversationRepo(db));
  // System Memory vault — an on-disk markdown directory (default ./bureau-vault).
  const memory = new VaultStore(env("BUREAU_VAULT", "./bureau-vault"));
  const usage = new DbUsage(new UsageRepo(db));
  const notifications = new DbNotifications(new NotificationRepo(db));

  // The orchestrator needs an EventSink, the WsHub needs the http server, and the
  // http server needs the orchestrator — so the sink forwards to the hub once it
  // exists.
  let hub: WsHub | undefined;
  const events: EventSink = { emit: (event: WsEvent) => hub?.emit(event) };

  const orchestrator = new Orchestrator({
    store,
    capabilities,
    provider,
    projects,
    vcs: vcsFor,
    events,
    messages,
    conversations,
    memory,
    usage,
    notifications,
    ids: () => randomUUID(),
    clock: () => new Date().toISOString(),
  });

  // Move any pre-thread chat into a conversation so it isn't lost.
  orchestrator.migrateOrphanMessages();

  const server = createHttpServer({ orchestrator, store, messages });
  hub = new WsHub();

  // Embedded terminal (human-operated shell console) on ws:/terminal, scoped to a
  // project's canonical clone. Iris can read its recent output (propose→run→observe).
  const terminal = new TerminalHub({
    resolveCwd: (projectId) => {
      try {
        return projects.resolve(projectId).canonicalPath;
      } catch {
        return projects.default().canonicalPath;
      }
    },
    resolveId: (projectId) => {
      try {
        return projects.resolve(projectId).id;
      } catch {
        return projects.default().id;
      }
    },
  });
  orchestrator.attachTerminal((projectId) => terminal.recentOutput(projectId));

  // Route WebSocket upgrades by path. Both hubs use noServer:true — a single
  // dispatcher hands each upgrade to the right one (the panel feed vs the terminal).
  //
  // SECURITY — Origin check: a WebSocket connection is NOT bound by the same-origin
  // policy, so without this ANY website open in the CEO's browser could connect to
  // ws://localhost/terminal and run arbitrary shell commands on this machine. We allow
  // only same-machine (localhost/127.0.0.1/::1) browser origins; a missing Origin is a
  // non-browser client (curl/CLI) which can already run local commands anyway and poses
  // no cross-site risk. Any other (a real website's) Origin is rejected.
  const wsHub = hub;
  server.on("upgrade", (req, socket, head) => {
    if (!sameMachineOrigin(req.headers.origin)) {
      socket.destroy();
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/ws") wsHub.handleUpgrade(req, socket, head);
    else if (pathname === "/terminal") terminal.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  // Clean up any task a previous crash/forced-exit left mid-flight BEFORE serving,
  // so the panel never sees a zombie task with an orphaned worktree.
  const reclaimed = await orchestrator.reconcile();
  if (reclaimed > 0) console.log(`[engine] reconcile: aborted ${reclaimed} interrupted task(s) from a previous run.`);

  // Bind to loopback ONLY — never 0.0.0.0. The engine drives a shell (the terminal) and
  // must not be reachable from other machines on the network; "localhost only" is now
  // enforced, not just documented.
  server.listen(port, "127.0.0.1", () => {
    console.log(`Bureau engine listening on http://localhost:${port} (ws: /ws)`);
    console.log(`Projects: ${projects.list().map((p) => `${p.owner}/${p.name}`).join(", ")}`);
  });

  // Graceful shutdown: drain in-flight pipelines so a restart never abandons a
  // half-run task mid-commit, then close the socket server and HTTP server.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[engine] ${signal} — draining in-flight pipelines…`);
    void orchestrator.settleAll().finally(() => {
      hub?.close();
      terminal.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref(); // hard stop if something hangs
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[engine] failed to start:", err);
  process.exit(1);
});
