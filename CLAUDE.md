# Bureau

Local-first AI agent team that works on the user's GitHub repositories. The user is CEO and talks exclusively with **Iris** (the orchestrator). Iris materialises a persistent **Task** and delegates to stateless **capability** workers (plan/edit/test/review/document). State is the truth; agents are replaceable operatives.

See the umbrella workspace `CLAUDE.md` (one level up, in the maintainer's local workspace) for cross-project rules, agent model tiers, and the orchestrator-vs-subagent policy.

## Tech stack

- Monorepo: pnpm workspaces, NO Turborepo
- TypeScript throughout; tsconfig project references
- SQLite via Drizzle ORM (`better-sqlite3` sync, zero extra processes)
- Next.js App Router (panel, localhost only)
- Persistent daemon: Node (`apps/engine`, HTTP + WebSocket)
- Lint boundary enforcement: dependency-cruiser

## Packages & apps

| Package | Role |
|---|---|
| `packages/core` | Pure domain — Task/Step/Gate/Artifact/DecisionLog types + `transition()` + `canPush()`. Zero I/O, zero runtime deps on other `@bureau/*` packages. |
| `packages/db` | SQLite schema (Drizzle), migrations, repo layer. Imports `core`. |
| `packages/providers` | Model adapters (Anthropic/OpenAI/Gemini) + auth strategies. Imports `core`, `contracts`. <!-- Only the Anthropic adapter (API + `claude` CLI) is wired today; OpenAI/Gemini are declared but ABSENT — implement per phase. --> |
| `packages/vcs` | git/gh subprocess wrapper, worktree lifecycle. Imports `core`. |
| `packages/mind` | Obsidian vault markdown read/write. Imports `core`. |
| `packages/capabilities` | Stateless capability workers: plan/edit/test/review/document. Imports `core`, `providers`, `contracts`. |
| `packages/contracts` | Zod DTOs shared between panel and engine. No imports from other `@bureau/*` at runtime. |
| `apps/engine` | Persistent Node daemon — HTTP + WebSocket. Imports all packages. |
| `apps/panel` | Next.js panel. Imports **only** `contracts` at runtime (lint-enforced). |

## The golden dependency rule

```
core        ← no @bureau/* imports at runtime
contracts   ← no @bureau/* imports at runtime
db          ← core only
vcs         ← core only
mind        ← core only
providers   ← core, contracts
capabilities← core, providers, contracts
engine      ← all packages
panel       ← contracts only  (lint gate: dependency-cruiser)
```

Violations are CI failures, not suggestions.

## Security wall

`canPush()` lives in `core` and is the **only** gate before any `push`, `openPr`, or `mergePr` call — all reached from exactly one place (the CEO's confirm-merge), only when `canPush() === true`. The realized human gate today is `pr_approval` (diff-review-and-merge); `plan_review`/`diff_review` are defined but reserved for later phases. A gate clears only on an explicit human decision. **Secrets:** the Anthropic key comes from `ANTHROPIC_API_KEY` at launch (or the local `claude` CLI); GitHub auth lives in `gh`. Bureau persists no secrets — the DB stores tasks, conversations, and chat, never credentials. <!-- 2026-06-14: corrected from an aspirational "encrypted secret_ref" claim that was never implemented; if a secrets store lands later (e.g. with OAuth), update this. -->`canPush()` is fail-closed and covered by exhaustive core tests.

## Confirmed simplifications (locked, do not re-open without explicit user decision)

1. **OAuth stub only** — `isAvailable() => false`; no OAuth work until explicitly requested.
2. **No Turborepo** — pnpm workspaces + tsc project references are sufficient.
3. **One capability first** — `edit` is implemented in Phase 1; others are registered as stubs in `CapabilityRegistry` and implemented per phase.

## Build phases

- **Phase 1–3:** core types, state machine, DB schema, provider adapters, VCS wrapper.
- **Phase 4 (thin vertical slice — the real milestone):** chat to Iris → Task with one `edit` step + one `diff_review` gate → isolated worktree change → diff in panel → human approval → real PR opened on GitHub.
- **Phase 5+:** parallel tasks, full capability set, panel sections beyond Assistant.

## Slash commands / agents / skills

- (populate as workflows mature)

## Project-specific notes

- Start with `packages/core/src/task.ts` (Task/Step/Gate/Artifact/DecisionLog types) and `packages/core/src/state-machine.ts` (`transition()` + `canPush()`) — pure, unit-testable, no deps.
- Panel runs at `localhost` only — never exposed externally.
- Each repo gets a **canonical clone**; tasks run in isolated **git worktrees** under that clone.
