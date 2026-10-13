#!/bin/sh
# Nightly backups (runs in the `backup` service, see compose.yaml):
#   - the database (pg_dump, custom format), and
#   - day2's files: per-app state inside the app checkouts (backlog, growth,
#     answers — not the code itself, which lives on GitHub) and /data.
# Keeps BACKUP_KEEP_DAYS (default 14) days. For copies off the server, see
# docs/deploy-hetzner.md → "Backups off the server".
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"
OUT=/backups
mkdir -p "$OUT"

run() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  echo "[backup] $stamp starting"
  pg_dump --format=custom --no-owner --file="$OUT/day2-db-$stamp.dump.partial" "$DATABASE_URL"
  mv "$OUT/day2-db-$stamp.dump.partial" "$OUT/day2-db-$stamp.dump"
  # Only day2's own files from each checkout (day2-*.json[l]) — the code
  # itself is on GitHub — and day2's own state in /data.
  (cd /managed-repos && find . -maxdepth 4 -type f \( -name 'day2-*.json' -o -name 'day2-*.jsonl' -o -name '.day2-*.json' \) -print0 \
    | tar --null -czf "$OUT/day2-files-$stamp.tar.gz" -T -)
  tar -czf "$OUT/day2-data-$stamp.tar.gz" -C /data .
  find "$OUT" -name 'day2-*' -type f -mtime "+$KEEP" -delete
  echo "[backup] $stamp done: $(ls -1 "$OUT" | wc -l) files kept"
}

if [ "${1:-}" = "--once" ]; then
  run
  exit 0
fi

# Daily at BACKUP_HOUR (UTC, default 03).
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) ${BACKUP_HOUR:-03}:00:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run || echo "[backup] FAILED"
done
