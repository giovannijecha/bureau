# Bureau

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

## Architecture

- **Monorepo:** pnpm workspaces + TypeScript project references (no Turborepo)
- **Storage:** SQLite via Drizzle ORM (`better-sqlite3`)
- **Panel:** Next.js App Router, localhost only — never exposed externally
- **Daemon:** Node (`apps/engine`, HTTP + WebSocket)
- **Boundaries:** enforced by dependency-cruiser (violations are CI failures)

## Security

`canPush()` lives in `packages/core` and is the **only** gate before any `push` or `openPr`. Human-review gates (`plan_review`, `diff_review`, `pr_approval`) accept only human decisions — the agent proposes, the human decides. Secrets are always encrypted at rest; the DB stores only a `secret_ref`, never plaintext.
