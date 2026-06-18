# Contributing to Bureau

Thanks for your interest in Bureau. This is a local-first AI agent team that turns plain-language requests into reviewed pull requests on your own GitHub repositories. Contributions are welcome — code, docs, bug reports, and ideas.

By contributing you agree that your contributions are licensed under the project's [Apache License 2.0](LICENSE).

## Ground rules

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) and the [Security Policy](SECURITY.md) first. Bureau is a tool that can push code to people's repositories, so **the security invariants in `SECURITY.md` are non-negotiable** — a change that weakens any of them will not be merged. The most important ones to keep in mind while contributing:

- `canPush()` in `packages/core` stays the **single** gate before any `push`/`openPr`/`mergePr`.
- The `edit` / `document` / `review` workers stay **shell-free**. The `test` worker stays **argv-only, no shell, opt-in**.
- The engine binds `127.0.0.1` only; the `/ws` and `/terminal` WebSockets keep their `Origin` check.
- Repository URLs stay allowlisted server-side (`assertSafeRepoUrl`); no credential is ever persisted.

If your change touches any of these, say so explicitly in your PR description.

## Development setup

**Prerequisites:** Node.js 18+, pnpm 9 (`corepack enable && corepack prepare pnpm@9 --activate`), `git`, and the GitHub CLI (`gh`) authenticated against your account.

```bash
git clone https://github.com/giovannijecha/bureau.git
cd bureau
pnpm install
```

## The quality gate

Run this before every commit and PR — it is exactly what CI enforces:

```bash
pnpm quality      # build + lint:boundaries + tests
```

Or individually:

```bash
pnpm build              # tsc --build across all packages (project references)
pnpm typecheck          # type-check without emitting
pnpm lint:boundaries    # enforce the golden dependency rule (dependency-cruiser)
pnpm test               # every package's vitest suite
pnpm --filter @bureau/panel typecheck   # the panel typechecks separately
```

A PR that doesn't pass `pnpm quality` will fail CI.

## The golden dependency rule

Imports only ever point inward, and this is **lint-enforced** — violations are CI failures, not suggestions:

```
core        ← no @bureau/* imports at runtime
contracts   ← no @bureau/* imports at runtime
db          ← core only
vcs         ← core only
mind        ← core only
providers   ← core, contracts
capabilities← core, providers, contracts
engine      ← all packages
panel       ← contracts only
```

Domain logic lives in `core` (pure, no I/O). The panel may import **only** `contracts`. If you find yourself wanting to import `db` or `engine` types into the panel, add a DTO to `contracts` instead.

## Project layout

```
packages/   core, db, providers, vcs, mind, capabilities, contracts
apps/       engine (Node daemon, HTTP + WebSocket), panel (Next.js, localhost only)
```

Good places to start reading: `packages/core/src/task.ts` (the domain types) and `packages/core/src/state-machine.ts` (`transition()` + `canPush()`) — both pure and unit-tested.

## Coding conventions

- **TypeScript**, strict — `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Don't paper over them with `any` or non-null `!`; handle the `undefined`.
- Match the style of the file you're editing — naming, comment density, and idioms. Keep it lean.
- Add or update tests for behavior changes. `core` logic should be covered by unit tests; the state machine and `canPush()` are exhaustively tested — keep them that way.
- No new runtime dependency without a reason in the PR description. Prefer the standard library.

## Commits & pull requests

- Branch off `main`; keep PRs focused on one concern.
- Write clear commit messages (imperative mood, explain the *why* when it isn't obvious).
- Fill in the PR template, including the security checkbox if relevant.
- Make sure `pnpm quality` is green locally before you open the PR.

## Reporting bugs & requesting features

Use the issue templates (Bug report / Feature request). For **security** issues, do **not** open a public issue — follow [SECURITY.md](SECURITY.md).
