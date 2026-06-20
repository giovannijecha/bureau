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
- **Persistence (two layers)** — a `systemd` **system service** with `Restart=always`
  restarts the engine on crash and auto-starts it on distro boot. But that is **not
  enough on its own**: a WSL distro itself terminates ~60s after its *last session*
  closes (verified — the service stops cleanly with the distro), so you also need a
  **keepalive** holding one session open. See "Keep it running" below.
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

## Keep it running (the keepalive)

A WSL2 distro terminates ~60s after its **last session** closes — which stops the
systemd services with it. So a logon-time **keepalive** holds one hidden session open.
Put a `.vbs` in the Windows Startup folder
(`%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\bureau-wsl-keepalive.vbs`):

```vbs
Set sh = CreateObject("WScript.Shell")
sh.Run "wsl.exe -d Ubuntu-26.04 -e sleep infinity", 0, False
```

It runs hidden at every logon; launch it once now with `wscript <path>` so the distro
stays up immediately. Confirm with `wsl -- pgrep -af 'sleep infinity'`. (If you already
keep a long-lived WSL session open for other work, you don't need this.)

## Operating

```sh
wsl -- systemctl status bureau-engine bureau-panel     # state
wsl -- journalctl -u bureau-engine -f                  # logs
wsl -- sudo systemctl restart bureau-engine            # restart after a redeploy
tr -d '\r' < deploy/wsl/01-deploy.sh | wsl.exe -e bash # pull + rebuild latest main
```
