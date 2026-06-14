# Bureau

![status](https://img.shields.io/badge/status-active-brightgreen)
![license](https://img.shields.io/badge/license-private-lightgrey)
![stack](https://img.shields.io/badge/stack-TypeScript-3178c6)
![package%20manager](https://img.shields.io/badge/pnpm-workspaces-f69220)
![storage](https://img.shields.io/badge/storage-SQLite%20%2B%20Drizzle-003b57)
![panel](https://img.shields.io/badge/panel-Next.js-000000)

Local-first AI agent team that works on your GitHub repositories. You are the CEO and talk exclusively with **Iris** (the orchestrator). Iris materialises a persistent **Task** and delegates to stateless **capability** workers (plan/edit/test/review/document). State is the truth; agents are replaceable operatives.

## About

Bureau is a local-first AI agent team that turns plain-language requests into reviewed pull requests on your own GitHub repositories — you stay the CEO while stateless workers do the work behind durable, human-gated Tasks.

## Quick Start

### Prerequisites

- **Node.js** 18+
- **pnpm** 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- **git** and the **GitHub CLI** (`gh`) authenticated against your account

### Install

```bash
git clone https://github.com/giovannijecha/bureau.git
cd bureau
pnpm install
```

### Build

```bash
pnpm build           # tsc --build across all packages
pnpm typecheck       # type-check without emitting
pnpm lint:boundaries # enforce the golden dependency rule
pnpm test            # run every package's test suite
pnpm quality         # build + boundaries + tests (the merge gate)
```

**CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the quality gate (build + boundaries + tests + panel typecheck) on every push and PR.

### Project layout

```
packages/   core, db, providers, vcs, mind, capabilities, contracts
apps/       engine (Node daemon), panel (Next.js, localhost only)
```

Start with `packages/core/src/task.ts` and `packages/core/src/state-machine.ts` — pure, unit-testable, no dependencies.

### Run the engine

The engine is configured entirely via env. Multi-repo:

```bash
BUREAU_PROJECTS='[{"owner":"you","name":"your-repo","url":"https://github.com/you/your-repo.git","baseBranch":"main"}]' \
BUREAU_REPOS_ROOT="$HOME/.bureau/repos" \   # each project clones to <root>/<id>/repo, worktrees under <root>/<id>/worktrees
BUREAU_GH_PATH="$(command -v gh)" \           # gh must be authenticated (run `gh auth setup-git` once)
BUREAU_AUTHOR_NAME="Bureau" BUREAU_AUTHOR_EMAIL="you@example.com" \
node apps/engine/dist/server.js               # listens on :4319 (HTTP + ws:/ws)
```

Provider: set `ANTHROPIC_API_KEY` to use the API directly, otherwise the engine delegates to the local `claude` CLI. Optional: `PORT` (4319), `BUREAU_DB` (`./bureau.db`), `BUREAU_VAULT` (`./bureau-vault` — the System Memory markdown vault), `BUREAU_GIT_PATH`. A single repo can also be configured with the legacy `BUREAU_REPO_OWNER` / `BUREAU_REPO_NAME` / `BUREAU_REPO_URL` / `BUREAU_CANONICAL` / `BUREAU_WORKTREES` vars.

Then run the panel (`apps/panel`) with `pnpm dev` and open it on localhost.

## How it works

You never drive the workers directly — you chat with Iris, and she turns the conversation into durable state that the engine executes in the background. Your decisive powers are exactly three: **Start**, **Stop**, and the final **Confirm-merge**.

```
chat ──▶ proposal ──▶ Task ──▶ Start ──▶ worktree ──▶ diff ──▶ confirm-merge ──▶ squash-merged
```

1. **chat** — you converse with Iris about the active **Project** (one of your repos). The chat is pure conversation — no diffs here.
2. **proposal** — when there's something concrete, Iris proposes a Task: a pipeline of steps. You can **Create** it, **Refine** the proposal, or keep chatting.
3. **Start** — you press Start. The engine runs the pipeline in an isolated git worktree **in the background** (it returns immediately), and the panel streams live progress over a WebSocket — you can walk away.
4. **diff** — a capability worker (e.g. `edit`) makes the change; it is committed **locally** on a branch and **never pushed**. You review the branch in the panel.
5. **confirm-merge** — your final confirmation squash-merges into `main` and deletes the branch. Only here, and only when `canPush()` returns `true`, does anything reach GitHub.

At any point you can **Stop** a running task — it aborts and tears down its worktree, having pushed nothing.

## Projects

One engine serves many repositories. Each repo is a **Project**; you pick the active one in the Assistant (a dropdown) so Iris scopes her proposals and tasks to it. Configure them with `BUREAU_PROJECTS` (see below).

## Capability workers

Stateless operatives that Iris delegates Task steps to. Each is replaceable — all durable context lives in the Task.

| Worker | Persona | Role | Status |
|---|---|---|---|
| `plan` | Planner | Read-only — lay out a concrete implementation plan the edit follows | ✅ Live |
| `edit` | Editor | Apply a code change directly in an isolated worktree | ✅ Live |
| `document` | Scribe | Update docs / README / changelog for the change | ✅ Live |
| `review` | Reviewer | Read-only — inspect the diff and flag issues before human review | ✅ Live |
| `test` | Tester | Run the project's configured test suite in the worktree (opt-in, advisory) | ✅ Live |

`edit`, `document`, and `review` are **agentic** — the model works the worktree files directly (confined to that directory; no shell). `edit`/`document` mutate; `review` is strictly read-only (read tools, no auto-accept) and its assessment is shown to you at the gate. Iris composes them into a multi-step pipeline (e.g. edit → document → review) that produces one reviewed diff. Workers are registered in the `CapabilityRegistry`; `createTask` refuses any capability that isn't registered, so an unbuilt worker can never silently no-op.

## Architecture

- **Monorepo:** pnpm workspaces + TypeScript project references (no Turborepo)
- **Storage:** SQLite via Drizzle ORM (`better-sqlite3`)
- **Panel:** Next.js App Router, localhost only — never exposed externally
- **Daemon:** Node (`apps/engine`, HTTP + WebSocket)
- **Boundaries:** enforced by dependency-cruiser (violations are CI failures)

### The golden dependency rule

Imports only ever point inward. `core` and `contracts` depend on no other `@bureau/*` package at runtime; `engine` may import everything; `panel` may import only `contracts`.

```
                 ┌──────────────────────────────┐
                 │            engine             │  imports all packages
                 └──────────────────────────────┘
                    ▲     ▲     ▲      ▲      ▲
        ┌───────────┘     │     │      │      └───────────┐
        │                 │     │      │                  │
   ┌─────────┐      ┌──────────┐│ ┌────────┐         ┌────────┐
   │   db    │      │ providers ││ │  vcs   │         │  mind  │
   │ (core)  │      │(core,     ││ │ (core) │         │ (core) │
   └─────────┘      │ contracts)││ └────────┘         └────────┘
        │           └──────────┘│      │                  │
        │            ▲     ▲     │      │                  │
        │            │     │  ┌──────────────┐             │
        │            │     │  │ capabilities │             │
        │            │     │  │(core,        │             │
        │            │     │  │ providers,   │             │
        │            │     │  │ contracts)   │             │
        │            │     │  └──────────────┘             │
        ▼            ▼     ▼          ▼                    ▼
   ┌──────────────────────────────────────────────────────────┐
   │   core   (no @bureau/* imports)   contracts  (no imports) │
   └──────────────────────────────────────────────────────────┘

   panel ──▶ contracts only   (lint gate: dependency-cruiser)
```

## Security

`canPush()` lives in `packages/core` and is the **only** gate before any `push`, `openPr`, or `mergePr`. These three run from exactly one place — the CEO's final confirm-merge — inside an `if (canPush(task))` branch; the background pipeline only ever commits locally. The human gate realized today is `pr_approval` (the diff-review-and-merge confirmation); `plan_review` and `diff_review` are defined in the type system and reserved for later phases. A gate only clears on an explicit human decision — the agent proposes, the human decides.

**Secrets:** the Anthropic API key is supplied via `ANTHROPIC_API_KEY` at launch (or the local `claude` CLI is used instead); GitHub auth is held by `gh` itself. Bureau persists **no** secrets — the database stores tasks, conversations, and the chat, never credentials.

**Workers are shell-free; the `test` worker is the one command-runner.** The agentic workers (`edit`, `document`, `review`) only read/edit files — they have **no shell**. Since no edit tool can delete or rename a file, the `edit` worker requests those in a small `.bureau-ops` manifest, which Bureau applies with Node `fs` (every path confined to the worktree, no shell, no injection surface). The one exception is the **`test`** worker, which runs your project's configured test suite (opt-in, argv-only, no shell). It is therefore **opt-in** (only the per-project `testCommand` you configure ever runs — never anything an LLM, the chat, or a diff could inject), spawned **argv-only with no shell** (metacharacters are inert), confined to the task's worktree, with a timeout + kill and a capped output. Its result is **advisory** — a pass or fail is shown to you at the gate (it never auto-merges, and a failure never blocks or hides the diff), so `canPush()` remains the sole gate. Bureau's own credentials (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`) are stripped from the test process's environment; other env vars are inherited (your test suite runs with the same trust as you running it in your own terminal). Configure it per project: `"testCommand": ["npm","test"]` in `BUREAU_PROJECTS` (or `BUREAU_TEST_COMMAND` for the single-repo path). On Windows, point it at a non-shim binary (e.g. `["node","node_modules/.bin/vitest","run"]`), since `npm`/`pnpm` shims can't be spawned without a shell.

## Roadmap

- **Phase 1–4 — Foundations + vertical slice ✅:** core types, state machine (`transition()` + `canPush()`), DB schema, provider adapters, VCS wrapper; chat → Task → isolated worktree change → diff review → real squash-merged PR on GitHub.
- **Phase 5 — Team + polished panel (current) ✅:** `edit` + `document` workers with multi-step pipelines; ChatGPT-style conversations; live progress over WebSocket; the full panel (Assistant, **Hub**, Projects, Tasks with search/filter/sort, Git, **Terminal**, Agents, **Memory**, **Metrics**, **Notifications**, Settings) with light/dark themes (the former Overview is folded into the Hub). The **Hub** is a live work floor over the capability workers + a cross-task activity feed + a "waiting on you" review queue. **System Memory** is an Obsidian-style markdown vault: every finished task auto-writes a journal (goal, pipeline, outcome) and the CEO can pin notes Iris should remember. **Metrics** turns the token counts every provider already returns into per-worker / per-model / per-day spend with a USD estimate — so you can trust what the agents cost. **Notifications** is a durable inbox (with a header bell + unread count) that fires the moment a task is ready for your review, merges, or fails — so you never miss an approval when you look away. Tasks report an **honest merge state** — a confirmed merge that hits conflicts shows "merge failed" with the open-PR link, never a false "merged".
- **Next:** parallel-task concurrency and mid-pipeline review gates (`plan_review` / `diff_review`) surfaced in the panel.
