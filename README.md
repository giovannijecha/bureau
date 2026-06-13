# Bureau

![status](https://img.shields.io/badge/status-phase%204-blue)
![license](https://img.shields.io/badge/license-private-lightgrey)
![stack](https://img.shields.io/badge/stack-TypeScript-3178c6)
![package%20manager](https://img.shields.io/badge/pnpm-workspaces-f69220)
![storage](https://img.shields.io/badge/storage-SQLite%20%2B%20Drizzle-003b57)
![panel](https://img.shields.io/badge/panel-Next.js-000000)

Local-first AI agent team that works on your GitHub repositories. You are the CEO and talk exclusively with **Iris** (the orchestrator). Iris materialises a persistent **Task** and delegates to stateless **capability** workers (plan/edit/test/review/document). State is the truth; agents are replaceable operatives.

## Quick Start

### Prerequisites

- **Node.js** 18+
- **pnpm** 9 (`corepack enable && corepack prepare pnpm@9 --activate`)
- **git** and the **GitHub CLI** (`gh`) authenticated against your account

### Install

```bash
git clone https://github.com/giovannijecha/Bureau.git
cd Bureau
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

## How it works

You never drive the workers directly — you chat with Iris, and she turns the conversation into durable state that the engine executes step by step.

```
chat ──▶ Task ──▶ worktree ──▶ diff ──▶ approval ──▶ PR
```

1. **chat** — you describe the change to Iris in plain language.
2. **Task** — Iris materialises a persistent Task (steps + gates) in SQLite; this state, not the agent, is the source of truth.
3. **worktree** — the engine checks out an isolated git worktree under the repo's canonical clone, so concurrent tasks never collide.
4. **diff** — a capability worker (e.g. `edit`) makes the change; the resulting diff is surfaced in the panel.
5. **approval** — a human-review gate (`diff_review`) waits for *your* decision. The agent proposes, you decide.
6. **PR** — only once `canPush()` returns `true` does the engine `push` and `openPr` via `gh`.

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

`canPush()` lives in `packages/core` and is the **only** gate before any `push` or `openPr`. Human-review gates (`plan_review`, `diff_review`, `pr_approval`) accept only human decisions — the agent proposes, the human decides. Secrets are always encrypted at rest; the DB stores only a `secret_ref`, never plaintext.

## Roadmap

- **Phase 1–3 — Foundations:** core types, state machine (`transition()` + `canPush()`), DB schema (Drizzle), provider adapters, VCS wrapper. The `edit` capability lands here; the rest are registered as stubs.
- **Phase 4 — Thin vertical slice (the real milestone):** chat to Iris → Task with one `edit` step + one `diff_review` gate → isolated worktree change → diff in panel → human approval → real PR opened on GitHub.
- **Phase 5+ — Parallelism & breadth:** parallel tasks, the full capability set (plan/test/review/document), and panel sections beyond Assistant.
