#!/usr/bin/env bash
# Verify the PATH crux + native data dirs on the RUNNING engine service (no networking needed).
set +e
PID="$(systemctl show -p MainPID --value bureau-engine.service)"
echo "engine MainPID: $PID"
echo "===== engine process PATH (what its shell-free spawns inherit) ====="
PENV="$(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep '^PATH=')"
echo "$PENV"
EPATH="${PENV#PATH=}"

echo "===== do the spawned tools resolve under THAT exact PATH? ====="
for t in bun pnpm npm node git gh claude; do
  loc="$(PATH="$EPATH" command -v "$t" 2>/dev/null)"
  if [ -n "$loc" ]; then
    case "$loc" in
      /mnt/*) echo "  $t -> $loc   ** WINDOWS BLEED (/mnt) **" ;;
      *)      echo "  $t -> $loc" ;;
    esac
  else
    echo "  $t -> MISSING"
  fi
done

echo "===== bun actually runs under the engine PATH (the Windows ENOENT bug) ====="
PATH="$EPATH" bun --version 2>&1 | sed 's/^/  bun /'

echo "===== data dirs (must be native /home, never /mnt) ====="
grep -E '^BUREAU_(REPOS_ROOT|DB|VAULT)=' $HOME/bureau/apps/engine/.env | sed 's/^/  /'
ls -ld "$HOME/.bureau-data" "$HOME/.bureau-data/repos" 2>&1 | sed 's/^/  /'

echo "===== both services ====="
systemctl is-enabled bureau-engine bureau-panel 2>&1 | sed 's/^/  enabled: /'
systemctl is-active  bureau-engine bureau-panel 2>&1 | sed 's/^/  active:  /'
echo "done"
