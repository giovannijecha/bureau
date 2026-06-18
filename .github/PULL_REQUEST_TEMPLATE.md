<!-- Thanks for contributing to Bureau! Keep PRs focused on one concern. -->

## What & why

<!-- What does this change, and what problem does it solve? Link any related issue (e.g. "Closes #12"). -->

## How it was tested

<!-- Commands you ran, scenarios you checked. -->

## Checklist

- [ ] `pnpm quality` passes locally (build + `lint:boundaries` + tests)
- [ ] `pnpm --filter @bureau/panel typecheck` passes (if the panel changed)
- [ ] Added/updated tests for the behavior change
- [ ] The change respects the [golden dependency rule](../CONTRIBUTING.md#the-golden-dependency-rule)

## Security

- [ ] This change does **not** weaken any invariant in [SECURITY.md](../SECURITY.md) — single `canPush()` gate, shell-free workers, loopback + Origin-locked transport, no secrets at rest.
- [ ] If it touches push/merge, the engine's transport guard, the workers' confinement, or repo-URL handling, I've called that out above.
