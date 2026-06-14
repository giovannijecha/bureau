# Bureau

![status](https://img.shields.io/badge/status-phase%204-blue)
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
pnpm build          # tsc --build across all packages
pnpm typecheck      # type-check without emitting
pnpm lint:boundaries # enforce the golden dependency rule
```

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

Provider: set `ANTHROPIC_API_KEY` to use the API directly, otherwise the engine delegates to the local `claude` CLI. Optional: `PORT` (4319), `BUREAU_DB` (`./bureau.db`), `BUREAU_GIT_PATH`. A single repo can also be configured with the legacy `BUREAU_REPO_OWNER` / `BUREAU_REPO_NAME` / `BUREAU_REPO_URL` / `BUREAU_CANONICAL` / `BUREAU_WORKTREES` vars.

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

| Worker | Role | Status |
|---|---|---|
| `plan` | Break a request into ordered steps and gates | Stub |
| `edit` | Apply a code change inside an isolated worktree | ✅ Implemented (Phase 1) |
| `test` | Run the repo's test suite against the change | Stub |
| `review` | Inspect the diff and flag issues before human review | Stub |
| `document` | Update docs / changelog for the change | Stub |

Workers are registered in the `CapabilityRegistry`; stubs are wired now and implemented per phase.

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

`canPush()` lives in `packages/core` and is the **only** gate before any `push`, `openPr`, or `mergePr`. These three run from exactly one place — the CEO's final confirm-merge — inside an `if (canPush(task))` branch; the background pipeline only ever commits locally. Human-review gates (`plan_review`, `diff_review`, `pr_approval`) accept only human decisions — the agent proposes, the human decides. Secrets are always encrypted at rest; the DB stores only a `secret_ref`, never plaintext.

## Roadmap

- **Phase 1–3 — Foundations:** core types, state machine (`transition()` + `canPush()`), DB schema (Drizzle), provider adapters, VCS wrapper. The `edit` capability lands here; the rest are registered as stubs.
- **Phase 4 — Thin vertical slice (the real milestone):** chat to Iris → Task with one `edit` step + one `diff_review` gate → isolated worktree change → diff in panel → human approval → real PR opened on GitHub.
- **Phase 5+ — Parallelism & breadth:** parallel tasks, the full capability set (plan/test/review/document), and panel sections beyond Assistant.
