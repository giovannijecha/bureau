#!/usr/bin/env bash
# Deploy Bureau into the WSL-native filesystem: clone (or fast-forward), install
# (compiles better-sqlite3 for Linux), build. Idempotent. Runs in the Linux home —
# NEVER under /mnt/c (native FS is fast and avoids cross-FS native-module breakage).
set -euo pipefail

# --- PATH: the toolchain lives under the user's home (nvm/bun/.local) ---
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

REPO="https://github.com/giovannijecha/bureau.git"
DEST="$HOME/bureau"

echo "==> node $(node --version) | corepack $(corepack --version) | bun $(bun --version)"

# corepack provides pnpm from the repo's packageManager field — no global pnpm needed.
corepack enable >/dev/null 2>&1 || true

if [ -d "$DEST/.git" ]; then
  echo "==> existing checkout — fetching + fast-forwarding main"
  git -C "$DEST" fetch --quiet origin main
  git -C "$DEST" checkout --quiet main
  git -C "$DEST" reset --hard --quiet origin/main
else
  echo "==> cloning $REPO -> $DEST"
  git clone --quiet "$REPO" "$DEST"
fi
cd "$DEST"
echo "==> HEAD: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"

echo "==> pnpm install (this compiles better-sqlite3 natively)"
corepack pnpm install --frozen-lockfile 2>&1 | tail -20

echo "==> verifying the native module loads under Node $(node --version)"
# better-sqlite3 is a dep of @bureau/db (pnpm doesn't hoist it to the root) — resolve from there.
( cd packages/db && node -e 'const D=require("better-sqlite3"); const db=new D(":memory:"); db.exec("create table t(x)"); db.prepare("insert into t values (1)").run(); console.log("  better-sqlite3 OK ->", db.prepare("select count(*) c from t").get().c, "row(s)");' )

echo "==> pnpm build"
corepack pnpm build 2>&1 | tail -15

echo "==> DONE. Bureau built at $DEST"
