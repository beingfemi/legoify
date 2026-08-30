#!/bin/bash
# Auto-commits and pushes any local changes in this git repo every INTERVAL seconds.
# Started automatically by Cursor (see .vscode/tasks.json) when the project folder opens.
# Safe to Ctrl+C or close the terminal tab — it just stops watching, nothing is lost.

INTERVAL=120  # seconds between checks (periodic, not per-keystroke)
cd "$(dirname "$0")/.." || exit 1

echo "[watch-and-commit] watching $(pwd) every ${INTERVAL}s"

while true; do
  sleep "$INTERVAL"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    git add -A
    git commit -m "auto: sync $(date '+%Y-%m-%d %H:%M:%S')" >/dev/null
    if git push >/dev/null 2>&1; then
      echo "[watch-and-commit] pushed changes at $(date '+%H:%M:%S')"
    else
      echo "[watch-and-commit] commit made locally but push failed (check network/auth)"
    fi
  fi
done
