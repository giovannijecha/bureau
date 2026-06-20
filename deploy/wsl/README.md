# Running Bureau in WSL (recommended on Windows)

Bureau's workers run real commands in a task's worktree — install dependencies,
build, test, verify — through a **shell-free** argv runner (`spawn`, `shell:false`).
On Windows that means a project whose toolchain is `bun`/`pnpm`/native shims can't be
spawned (`spawn bun ENOENT`), so provisioning and verification silently fail. Running
the engine **inside WSL2 (Linux)** removes that whole class of failure at the root.

These scripts deploy the engine + panel into the WSL-native filesystem as persistent
**systemd services**, reachable from your Windows browser.

## Prerequisites (inside WSL)

- WSL2 with **systemd enabled** (`/etc/wsl.conf` → `[boot]\nsystemd=true`).
- Node ≥ 20 (the deploy pins Node 24), a C toolchain (`build-essential`) for the
  `better-sqlite3` native build, and `git`.
- `bun` if you work on Bun projects; any other stack's toolchain as needed.
- `gh` authenticated (`gh auth login` + `gh auth setup-git`).
- The Anthropic provider: either the `claude` CLI **logged in** (recommended — leave
  `ANTHROPIC_API_KEY` unset and the engine uses the CLI), or an API key.

## Deploy

Run from the Windows side; each script is piped CR-stripped into WSL so line endings
never matter:

```sh
for s in 00-probe 01-deploy 02-setup 03-verify; do
  tr -d '\r' < deploy/wsl/$s.sh | wsl.exe -e bash
done
```

- **00-probe** — read-only: reports the WSL toolchain + auth state.
- **01-deploy** — clones (or fast-forwards) Bureau into `~/bureau`, `pnpm install`
  (compiles `better-sqlite3` for Linux), builds, and smoke-tests the native module.
- **02-setup** — writes `apps/engine/.env`, `corepack enable`s pnpm, builds the panel,
  and installs + starts `bureau-engine` + `bureau-panel` systemd services.
- **03-verify** — proves the engine's spawn PATH carries `bun`/`pnpm`/`claude` and the
  data dirs are on the native FS.

Then open **http://localhost:3000**.

## The footguns these scripts handle

An adversarial review of the runbook surfaced several non-obvious traps; the scripts
encode the fixes:

- **The spawn PATH is the whole game.** WSL does *not* auto-fix `spawn bun ENOENT` — a
  systemd/`wsl -e`/`nohup` launch has a minimal PATH without nvm/bun/`~/.local`. The
  unit bakes an explicit **Linux-first** `Environment=PATH` (node, `~/.bun/bin`,
  `~/.local/bin`, `/usr/bin`) that **omits `/mnt/c`**, so `npm`/`corepack` can't resolve
  to Windows shims and run `node.exe` against Linux paths.
- **`corepack enable`** so a bare `pnpm` (what provisioning spawns) exists on PATH.
- **Provider** — `ANTHROPIC_API_KEY` is left unset so the authenticated `claude` CLI is
  used (the agentic workers require it); `~/.local/bin` is on the engine PATH.
- **Absolute, native data paths** for `BUREAU_REPOS_ROOT`, `BUREAU_DB`, **and
  `BUREAU_VAULT`** under `~/.bureau-data` — never CWD-relative (which could land the
  SQLite WAL + git worktrees on `/mnt/c` 9p, which is slow and breaks WAL locking).
- **Persistence** — a terminal/`nohup` engine is SIGKILLed ~60s after its session
  closes (WSL distro idle-shutdown). A **systemd system service** with `Restart=always`
  survives session close, restarts on crash, and itself holds the distro open.
- **`better-sqlite3` ABI** — installed and smoke-tested under the *same* Node the engine
  runs (never a Windows/`/mnt/c` node), on the native FS.

## Networking — reaching it from the Windows browser

The engine binds **`127.0.0.1` only** (deliberate: it drives a terminal shell channel,
so it must never be on the LAN). Under WSL2's default **NAT** networking, Windows
`localhost` does not reliably forward into WSL. Enable **mirrored networking** so Windows
and WSL share `127.0.0.1` — add to `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

then `wsl --shutdown` (restarts WSL; the enabled services auto-start on next boot). The
engine still binds loopback only, so this is **not** a security change — it stays off the
LAN. Verify with `curl http://localhost:4319/api/config` from Windows.

## Operating

```sh
wsl -- systemctl status bureau-engine bureau-panel     # state
wsl -- journalctl -u bureau-engine -f                  # logs
wsl -- sudo systemctl restart bureau-engine            # restart after a redeploy
tr -d '\r' < deploy/wsl/01-deploy.sh | wsl.exe -e bash # pull + rebuild latest main
```
