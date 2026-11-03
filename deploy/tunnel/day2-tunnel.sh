#!/usr/bin/env bash
# day2 for yourself, with ads: day2 runs on this computer (local mode), and a
# Cloudflare Tunnel makes exactly the paths public that the outside world
# needs — nothing else. The console and every other API path stay on this
# computer (local mode has no sign-in, so they must never be public).
#
#   /api/ads/connect/callback/<platform>   ad platforms send you back here after you sign in
#   /api/assets/<file>                      ad platforms fetch the ad images and videos
#   /api/l/<app> and /api/l/<app>/handoff.js  the store link, and the script your website loads
#   /api/ingest/...                         usage and crash reports from your app, its Live settings
#   /api/store-notify/(apple|google|revenuecat)/<app>  the App Store and Google Play tell day2 about purchases
#
# Usage (from the orchestrator folder):
#   DAY2_TUNNEL_HOST=day2.example.com deploy/tunnel/day2-tunnel.sh
#
# Needs: a domain on Cloudflare (free plan is fine) and cloudflared
# (macOS: brew install cloudflared). The first run opens a browser to log in
# to Cloudflare, creates the tunnel and its DNS record; later runs just start it.
set -euo pipefail

HOST="${DAY2_TUNNEL_HOST:-}"
NAME="${DAY2_TUNNEL_NAME:-day2}"
PORT="${DAY2_API_PORT:-4700}"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$DIR/.day2-tunnel.yml"

if [ -z "$HOST" ]; then
  echo "Set DAY2_TUNNEL_HOST to the address day2 should have, e.g. DAY2_TUNNEL_HOST=day2.example.com" >&2
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared isn't installed. On a Mac: brew install cloudflared" >&2
  exit 1
fi

[ -f "$HOME/.cloudflared/cert.pem" ] || cloudflared tunnel login

if ! cloudflared tunnel info "$NAME" >/dev/null 2>&1; then
  cloudflared tunnel create "$NAME"
fi
ID="$(cloudflared tunnel list --name "$NAME" -o json | grep -o '"id": *"[0-9a-f-]\{36\}"' | head -1 | grep -o '[0-9a-f-]\{36\}')"
if [ -z "$ID" ]; then
  echo "Couldn't find the tunnel \"$NAME\" after creating it." >&2
  exit 1
fi
# The DNS name for the tunnel. Fails when the name already points elsewhere: say so instead of hiding it.
if ! route_out="$(cloudflared tunnel route dns "$NAME" "$HOST" 2>&1)"; then
  if ! grep -qi "already configured to route to your tunnel" <<<"$route_out"; then
    echo "Couldn't create the DNS name $HOST for the tunnel:" >&2
    echo "$route_out" >&2
    echo "Check the domain's DNS records in Cloudflare (dash.cloudflare.com → the domain → DNS)." >&2
    exit 1
  fi
fi

# The public paths, strictly: no dots, percent signs or backslashes where an
# id goes, so nothing can climb out of them (ingest/%2e%2e/apps is
# /api/apps once normalized). day2 checks the same list itself
# (src/request-path.ts PUBLIC_PATH_SOURCE — keep the two identical).
cat >"$CONFIG" <<YAML
# Written by deploy/tunnel/day2-tunnel.sh — only these paths are public.
tunnel: $ID
credentials-file: $HOME/.cloudflared/$ID.json
ingress:
  - hostname: $HOST
    path: ^/api/(ads/connect/callback/[a-z]+|assets/[A-Za-z0-9_-]+(\.[a-z0-9]+)?|l/[A-Za-z0-9_-]+(/handoff\.js)?|ingest/d2k_[A-Za-z0-9_-]+(/(config|contracts|push))?|store-notify/(apple|google|revenuecat)/[A-Za-z0-9_-]+)$
    service: http://localhost:$PORT
  - service: http_status:404
YAML

# The server needs to know its public address, and where your browser finds the console.
ENV_FILE="$DIR/.env"
want_public="DAY2_PUBLIC_URL=https://$HOST"
want_console="DAY2_CONSOLE_URL=http://localhost:3000"
missing=()
grep -qx "$want_public" "$ENV_FILE" 2>/dev/null || missing+=("$want_public")
grep -qx "$want_console" "$ENV_FILE" 2>/dev/null || missing+=("$want_console")
if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "Put these lines in $ENV_FILE (replace any older DAY2_PUBLIC_URL / DAY2_CONSOLE_URL), then restart day2's server:"
  printf '  %s\n' "${missing[@]}"
  echo
fi

echo "Public paths of day2 at https://$HOST (everything else answers 404):"
echo "  /api/ads/connect/callback/<platform>, /api/assets/<file>, /api/l/<app>[/handoff.js], /api/ingest/<key>[/config|/contracts|/push], /api/store-notify/(apple|google|revenuecat)/<app>"
echo "Redirect URL to give the ad platforms' developer apps: https://$HOST/api/ads/connect/callback/<platform>"
echo
exec cloudflared tunnel --config "$CONFIG" run "$NAME"
