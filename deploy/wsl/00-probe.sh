#!/usr/bin/env bash
# Ground-truth probe for the Bureau-in-WSL deploy. Read-only: reports what's present.
# Sources the shared shell env so nvm/pyenv/etc. are on PATH (a non-interactive shell
# would otherwise skip ~/.bashrc and miss them).
set +e
[ -f "$HOME/.shell-env.sh" ] && . "$HOME/.shell-env.sh"
# nvm is loaded lazily by some setups — make sure node is reachable.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

line() { printf '%-14s %s\n' "$1" "$2"; }
tool() {
  if command -v "$1" >/dev/null 2>&1; then
    line "$1" "$(command -v "$1")  [$($1 --version 2>&1 | head -1)]"
  else
    line "$1" "MISSING"
  fi
}

echo "===== system ====="
line "distro" "$(. /etc/os-release && echo "$PRETTY_NAME")"
line "kernel" "$(uname -r)"
line "home" "$HOME"
line "nproc" "$(nproc)"

echo "===== toolchain ====="
for t in git curl node npm corepack pnpm bun gh claude python3 make gcc g++; do tool "$t"; done

echo "===== build headers (better-sqlite3 native) ====="
line "build-essential" "$(dpkg -s build-essential 2>/dev/null | awk -F': ' '/^Status/{print $2}' || echo absent)"

echo "===== auth ====="
echo "--- gh ---"
gh auth status 2>&1 | sed 's/^/  /' | head -6
echo "--- claude (anthropic) ---"
if command -v claude >/dev/null 2>&1; then
  # Don't trigger a login; just see if a token/config exists.
  if [ -f "$HOME/.claude/.credentials.json" ] || [ -f "$HOME/.config/claude/.credentials.json" ]; then
    echo "  claude credentials file present"
  else
    echo "  claude installed but NO credentials file found (not logged in)"
  fi
else
  echo "  claude MISSING"
fi
[ -n "$ANTHROPIC_API_KEY" ] && echo "  ANTHROPIC_API_KEY is set in this env" || echo "  ANTHROPIC_API_KEY not set in this env"

echo "===== existing bureau checkout in WSL ====="
for d in "$HOME/bureau" "$HOME/Bureau"; do
  [ -d "$d/.git" ] && line "$d" "exists ($(git -C "$d" rev-parse --short HEAD 2>/dev/null))" || line "$d" "—"
done

echo "===== done ====="
