#!/usr/bin/env bash
# Sets up day2's inbox at Cloudflare (worker.js): a Worker in front of day2's
# address that keeps app reports while day2 can't be reached (the computer
# sleeps), so nothing is lost. day2 fetches them when it's back. It also keeps
# each app's last Live config and serves it while day2 is away, and keeps
# App Store / Google Play purchase notifications the same way as reports.
#
# Usage (from the orchestrator folder), after the tunnel is set up:
#   deploy/inbox/setup.sh
#
# Needs: the domain on Cloudflare (it is, for the tunnel). The first run
# opens a browser to log in to Cloudflare (Wrangler, Cloudflare's tool).
# Free plan: D1 and Workers' free limits are far above what reports need.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$DIR/deploy/inbox"
ENV_FILE="$DIR/.env"
W="npx --yes wrangler@4"

PUBLIC="$(grep -E '^DAY2_PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
HOST="${DAY2_INBOX_HOST:-${PUBLIC#https://}}"
HOST="${HOST%/}"
if [ -z "$HOST" ] || [[ "$PUBLIC" != https://* && -z "${DAY2_INBOX_HOST:-}" ]]; then
  echo "Set DAY2_PUBLIC_URL=https://… in $ENV_FILE first (deploy/tunnel/day2-tunnel.sh)." >&2
  exit 1
fi
ZONE="$(awk -F. '{print $(NF-1)"."$NF}' <<<"$HOST")"

$W whoami >/dev/null 2>&1 || $W login

# The database (once).
DB_ID="$($W d1 list --json 2>/dev/null | tr -d '\n ' | grep -o '"uuid":"[0-9a-f-]\{36\}","name":"day2-inbox"' | grep -o '[0-9a-f-]\{36\}' || true)"
if [ -z "$DB_ID" ]; then
  DB_ID="$($W d1 list --json 2>/dev/null | tr -d '\n ' | grep -o '"name":"day2-inbox"[^}]*"uuid":"[0-9a-f-]\{36\}"' | grep -o '[0-9a-f-]\{36\}' || true)"
fi
if [ -z "$DB_ID" ]; then
  DB_ID="$($W d1 create day2-inbox 2>&1 | grep -o '[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}' | head -1)"
fi
if [ -z "$DB_ID" ]; then
  echo "Couldn't create or find the D1 database \"day2-inbox\"." >&2
  exit 1
fi

cat >"$HERE/wrangler.toml" <<TOML
# Written by deploy/inbox/setup.sh
name = "day2-inbox"
main = "worker.js"
compatibility_date = "2025-10-01"
workers_dev = false
routes = [
  { pattern = "$HOST/api/ingest/*", zone_name = "$ZONE" },
  { pattern = "$HOST/api/store-notify/*", zone_name = "$ZONE" },
  { pattern = "$HOST/__inbox*", zone_name = "$ZONE" },
]

[[d1_databases]]
binding = "DB"
database_name = "day2-inbox"
database_id = "$DB_ID"
TOML

cd "$HERE"
$W d1 execute day2-inbox --remote --file schema.sql --yes >/dev/null

# The token day2 uses to fetch what's waiting (kept in .env, never shown).
TOKEN="$(grep -E '^DAY2_INBOX_TOKEN=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 24)"
  printf 'DAY2_INBOX_URL=https://%s\nDAY2_INBOX_TOKEN=%s\n' "$HOST" "$TOKEN" >>"$ENV_FILE"
fi
printf '%s' "$TOKEN" | $W secret put INBOX_TOKEN >/dev/null
$W deploy

echo
echo "day2's inbox is live at https://$HOST: reports and store notifications are kept there while day2 can't be reached, and apps get their last Live settings."
echo "Restart day2's server so it fetches them (DAY2_INBOX_URL and DAY2_INBOX_TOKEN are in $ENV_FILE)."
