# Security Policy

Bureau is an AI agent team that reads, edits, and (on your explicit confirmation) pushes code to your GitHub repositories. Security is the product's first constraint, not an afterthought. This document explains how to report a vulnerability and the guarantees Bureau is built to keep.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's [private vulnerability reporting](https://github.com/giovannijecha/bureau/security/advisories/new):

1. Go to the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, the impact, and a reproduction if you have one.

We aim to acknowledge a report within **72 hours** and to ship a fix or a documented mitigation for confirmed high-severity issues as a priority. You will be credited in the advisory unless you ask otherwise.

If you cannot use GitHub's reporting flow, open a minimal issue asking a maintainer to contact you privately — **without** disclosing the vulnerability details.

## Supported versions

Bureau is pre-1.0 and ships from `main`. Security fixes land on `main`; there are no backported release branches yet. Run the latest `main`.

## Threat model & design guarantees

Bureau runs **locally** — the engine binds `127.0.0.1` only and the panel is localhost-only; it is never meant to be exposed on a public interface. Within that model, the following invariants are load-bearing. A change that weakens any of them is a security regression and will be treated as a blocker.

- **One push gate.** `canPush()` in `packages/core` is the *only* function that authorizes `push`, `openPr`, or `mergePr`. It is fail-closed and exhaustively unit-tested. Every call site sits behind it, reached from exactly one place: the CEO's final confirm-merge. The background pipeline only ever commits **locally**.
- **Human-in-the-loop.** Agents propose; a human decides. No gate clears without an explicit human action; nothing reaches GitHub without the CEO's confirm-merge.
- **Shell-free workers.** The `edit`, `document`, and `review` workers have **no shell** — they only read/edit files inside their own git worktree. File deletes/renames go through a `.bureau-ops` manifest applied with Node `fs` (every path confined to the worktree). The single command-runner is the **`test`** worker: opt-in, argv-only with **no shell** (metacharacters are inert), confined to the worktree, timeout + output cap, and advisory only.
- **No secrets at rest.** Bureau persists **no** credentials. The Anthropic key comes from `ANTHROPIC_API_KEY` at launch (or the local `claude` CLI); GitHub auth lives in `gh`. The database stores tasks, conversations, and chat — never secrets. Bureau's own credentials are stripped from the `test` worker's environment.
- **Origin-locked transports.** The `/ws` and `/terminal` WebSockets enforce a same-machine `Origin` check to prevent Cross-Site WebSocket Hijacking; the engine never binds a non-loopback interface.
- **Allowlisted repo sources.** A repository URL added from the UI is validated server-side (`assertSafeRepoUrl`): `https://` on `github.com` only; `file://`, git remote-helper transports (`ext::`/`transport::`/`fd::`), scp/ssh forms, and embedded credentials are rejected. Identity is derived from the parsed URL, never trusted from the client. No token is ever accepted or persisted.

## Scope

In scope: the engine, panel, capability workers, the VCS/`gh` wrapper, and the database layer in this repository.

Out of scope: vulnerabilities in third-party dependencies (report upstream), issues that require already having local shell access to the machine running Bureau (Bureau trusts the local operator), and anything that depends on running the engine on a public interface (an explicitly unsupported configuration).
