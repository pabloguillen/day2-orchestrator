# day2's inbox at Cloudflare

When day2 runs on your own computer (local mode with the tunnel), app reports only arrive while the computer is awake. The inbox fixes that: a small Cloudflare Worker in front of day2's address passes reports through as usual. When day2 can't be reached (the computer sleeps, the tunnel or the server is off), it keeps them in a Cloudflare D1 database and tells the app "accepted". day2 fetches what's waiting every minute once it's back, handles each report as if it had just arrived, and confirms. Only then are they deleted at Cloudflare.

- **What's kept:** reports (`POST /api/ingest/<key>`, up to 66 kB each), push tokens (`POST /api/ingest/<key>/push`), and App Store / Google Play notifications (`POST /api/store-notify/apple|google/<app>`). Everything else passes through or is refused.
- **Store notifications:** the stores hear `200`, since they count only that as delivered. day2 replays each to its own path. The Authorization header isn't kept. A notification nobody handles yet (404) stays in the inbox.
- **Live settings:** `GET /api/ingest/<key>/config` passes through, and the last good answer per key is kept. While day2 can't be reached, apps get that copy (with its `etag`; header `x-day2-kept: 1`). See [live.md](live.md).
- **Kept at most 14 days and 200,000 reports, and at most 20,000 per app key** (a key's reports and push tokens together; each app's store notifications on their own). Beyond that, new ones are refused until day2 catches up, so one flooded key can't fill the inbox for the others.
- **Replays:** day2 hands each kept report to its own handler in-process (no HTTP), marked as a replay. Replays have their own, larger allowance per key and no per-address limit. A report day2 can't take right now (busy, an error, a store notification nobody handles yet) is skipped for that round and tried again in the next; the rest go on.
- **Fetching needs a secret token** (`DAY2_INBOX_TOKEN`). It's generated at setup, kept in `orchestrator/.env`, and stored as a Worker secret.
- **No Anthropic key needed:** it stores, nothing more. It fits easily in Cloudflare's free limits.
- **Privacy:** while waiting, a report's IP address and browser string are kept with it, because day2 uses them for web ad conversions, exactly as when it arrives directly. Deleted once day2 has taken it.

## Setup (once)

From the orchestrator folder, after the tunnel is set up and `DAY2_PUBLIC_URL` is in `.env`:

```bash
deploy/inbox/setup.sh
```

The first run opens a browser to log in to Cloudflare (Wrangler). The script:
- creates the D1 database `day2-inbox` and its table (`schema.sql`);
- writes `wrangler.toml` with routes for `<your host>/api/ingest/*` and `<your host>/__inbox*`;
- sets the secret token, deploys the Worker, and adds `DAY2_INBOX_URL` / `DAY2_INBOX_TOKEN` to `.env`.

Then restart day2's server. From then on it logs `[day2-inbox] took N reports kept while day2 was away` after waking up.

## Deployed day2

In the cloud, day2 is always reachable, so the inbox is optional. It still covers deploys and outages. Same setup, with `DAY2_INBOX_HOST` set if it should differ from `DAY2_PUBLIC_URL`.

**Status:** built and tested against a fake D1. Not yet run against a real Cloudflare account.
