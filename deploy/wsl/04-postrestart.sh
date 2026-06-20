#!/usr/bin/env bash
# Run right after a `wsl --shutdown` + boot: wait for systemd to bring the enabled
# Bureau services up, and confirm mirrored networking took effect.
set +e
echo "system state: $(systemctl is-system-running 2>&1)"
echo "networkingMode (mirrored => loopback shared with Windows):"
# Under mirrored networking the WSL host sees the Windows adapters / loopback is shared.
ip -brief addr show 2>/dev/null | sed 's/^/  /' | head -6

echo "waiting for bureau-engine to answer inside WSL (127.0.0.1:4319)…"
up=""
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null http://127.0.0.1:4319/api/config 2>/dev/null; then up=1; break; fi
  sleep 1
done
echo "  engine active: $(systemctl is-active bureau-engine) | panel active: $(systemctl is-active bureau-panel)"
if [ -n "$up" ]; then
  echo "  ENGINE UP (in-WSL). /api/config:"
  curl -fsS http://127.0.0.1:4319/api/config 2>&1 | head -c 400; echo
else
  echo "  ENGINE NOT UP — logs:"
  journalctl -u bureau-engine --no-pager -n 25
fi
echo "done"
