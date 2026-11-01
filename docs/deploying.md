# Deploying day2: from your Mac to the cloud

This is the full checklist for moving day2 from **local mode** to **accounts mode**:

- **Local mode** runs on your Mac. Nobody signs in, everything is kept in JSON files next to the orchestrator, and agents use your Claude subscription.
- **Accounts mode** runs in the cloud for customers. People sign in, and everything is kept in Postgres.

The server decides by itself which mode it's in (`serverMode()` in `src/tenant.ts`). If `DATABASE_URL` is set, it's accounts mode. If not, it's local mode.

How to use this guide:

- **Doing the server itself:** follow [deploy-hetzner.md](deploy-hetzner.md) step by step.
- **The short version of that:** [go-live-checklist.md](go-live-checklist.md).
- **Everything else** day2 needs before customers arrive is in the sections below, in order, and nothing in them is left out.

Each item lists: **what** it is · **why** day2 needs it · **where** to get it · **env var(s)**.

All settings go in `deploy/.env` on the server ([deploy-hetzner.md §4](deploy-hetzner.md#4-get-the-code-and-fill-in-the-settings)). Never put them in the repo or in a chat. Status labels used below:

- **not built yet**: the code doesn't do it.
- **built, not verified**: the code exists but has never run against real accounts.

---

## 0. What the server checks when it starts

The Docker image sets `NODE_ENV=production`. With that set, `assertProductionReady()` (`src/tenant.ts`) **refuses to start** unless all of these are present:

- `DATABASE_URL`, `DAY2_PUBLIC_URL`, `DAY2_SECRETS_KEY` and `ANTHROPIC_API_KEY`;
- at least one way to sign in: GitHub (`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`), Google (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`) or email (`SMTP_URL`).

After that check, the API applies the database migrations (`src/db/migrations/*.sql`) and starts the background timer.

Everything else on this list is **not** checked at startup. If it's missing, the feature behind it simply switches off. So "it started" does not mean "it's ready". Use the smoke test at the end.

---

## 1. Server, domain, HTTPS

- [ ] **Server.** A Hetzner CX23 running Ubuntu 24.04, with a firewall allowing only 22, 80 and 443. It runs the whole stack with Docker Compose. See [deploy-hetzner.md §1–2](deploy-hetzner.md#1-create-the-server).
- [ ] **Sandbox setting.** Set `kernel.apparmor_restrict_unprivileged_userns=0` on the server (deploy-hetzner §2). Agents only run inside bubblewrap, and Ubuntu blocks bubblewrap by default. `deploy/compose.yaml` already runs the api container with `seccomp:unconfined` and `apparmor:unconfined` for the same reason.
- [ ] **Domain.** Create a DNS A record, e.g. `app.yourdomain.com`, pointing at the server. Every redirect URL below is built from this domain, so pick it before creating any developer app.
  → `DAY2_DOMAIN` (in `deploy/.env`)
- [ ] **HTTPS.** Nothing to do. Caddy (`deploy/Caddyfile`) gets and renews the certificate on its own. It sends `/api/*` to the orchestrator (with 15-minute timeouts for long agent calls) and everything else to the console. Console and API share one origin, so there is no CORS setup.
- [ ] **Public address.** `compose.yaml` sets it from your domain (`https://${DAY2_DOMAIN}`). It's used to build:
  - sign-in redirects;
  - ad-platform callbacks;
  - URLs of ad images and videos (the platforms fetch them);
  - the endpoint apps report to.

  Cookies only get `Secure` when it starts with `https://`.
  → `DAY2_PUBLIC_URL`
- [ ] **Proxy trust.** Already set to `on` by compose, so rate limits see real client IPs. Leave it.
  → `DAY2_TRUST_PROXY`
- [ ] **Console.** Needs no settings in production. It's built from the `console` repo, which must sit next to the orchestrator repo, or set `CONSOLE_DIR`. Its only env vars are development ones (`VITE_DAY2_API_BASE` for e2e tests, `DAY2_API_URL` for the vite proxy, and `PORT` / `HOST` in `serve.mjs`, set by its Dockerfile).

**Local-only settings: do not set them in production.**

| Env var | What it does locally | In production |
|---|---|---|
| `DAY2_CONSOLE_URL` | Where your browser finds the console when only the tunnel is public | Falls back to `DAY2_PUBLIC_URL`. Leave unset |
| `DAY2_CONSOLE_ORIGIN` | The CORS origin for vite on `:3000` | Ignored |
| `DAY2_DEV_LOGIN` | Sign in as anyone without GitHub | Ignored |
| `DAY2_ALLOW_LOCAL_PATHS` | Connect server folders as apps | Ignored |
| `DAY2_API_HOST` | Bind address (defaults to `0.0.0.0` in production) | Leave unset |
| `DAY2_CONSOLE_API_PORT` | API port (4700, set in the Dockerfile) | Leave |
| `DAY2_APPS_REGISTRY_PATH`, `DAY2_CREDITS_DIR` | Where the JSON files live (tests) | Not used for data. `DAY2_DATA_DIR=/data` is set in the Dockerfile |
| `DAY2_TEST_DATABASE_URL` | Test suite only | Leave unset |

`deploy/tunnel/day2-tunnel.sh` (a Cloudflare Tunnel) is **local mode only**. It makes four path groups of your Mac public: ad callbacks, assets, store links and ingest. Don't use it in production; Caddy replaces it. If you used it, your developer apps have redirect URLs on the *tunnel* host. Add the production ones as well (section 6).

---

## 2. Database

- [ ] **Postgres 16.** Runs in the `postgres` service of `compose.yaml`. It isn't published to the internet, and its data lives on the `pgdata` volume. Generate the password with `openssl rand -base64 32`.
  → `POSTGRES_PASSWORD` (compose builds `DATABASE_URL` from it for you)
- [ ] **Migrations.** Automatic on every API start (`migrate()` in `src/db/index.ts`). They run under an advisory lock, so two servers can't race. Nothing to run by hand. Check `docker compose logs api` for `[day2-db] Applied: …`.
- [ ] **Pool size** (optional). Default 10.
  → `DATABASE_POOL_SIZE`
- [ ] Using a managed Postgres instead (Hetzner doesn't offer one; Neon, Supabase, RDS…)? Set `DATABASE_URL` yourself and remove the `environment: DATABASE_URL` line from compose's `api` and `backup` services. The compose `environment` block overrides `.env`.

---

## 3. Claude (the agents)

- [ ] **Anthropic API key.** Every agent run needs it: fixes, backlog work, research, ad copy, Ask day2. Required, and the server won't start without it.
  - **Why not your subscription:** locally, without a key, agents fall back to your Mac's Claude Code login (your Max subscription), and the server prints a warning. A consumer subscription is for one person's interactive use. Anthropic doesn't allow it to power a product other people use (see the comment in `assertProductionReady` and the top of `README.md`), and a server has no Claude Code login anyway.
  - **Where:** console.anthropic.com → API keys. Create the key under a workspace with a spend limit, and set up billing alerts.
  → `ANTHROPIC_API_KEY`
- [ ] **Model** (optional). All agent calls use one model; the default is `claude-sonnet-5`. Only set it to pin or change the model.
  → `DAY2_MODEL`
- [ ] **Credits metering stays on.** Never set `DAY2_CREDITS=off` in production. It turns off charging customers for agent use (`src/metered-query.ts`), and production does **not** refuse it.
  → `DAY2_CREDITS` (leave unset)
- [ ] **Currency** (optional). Provider costs are in USD, and credits are priced in EUR. Default rate is 0.95.
  → `DAY2_USD_TO_EUR`, plus per-currency ad budget overrides `DAY2_FX_<CUR>` (e.g. `DAY2_FX_EUR`) and tool price overrides `DAY2_TOOL_COST_<TOOL>_USD`

---

## 4. The encryption key

- [ ] **`DAY2_SECRETS_KEY`.** 32 random bytes, base64 (`openssl rand -base64 32`). Required. It encrypts every stored token with AES-256-GCM:
  - JIRA and Linear;
  - ad-platform connections;
  - day2's tool connectors (Foreplay, Runway, Meta MCP);
  - customers' release credentials (Expo, App Store Connect, Google Play);
  - rotated ad refresh tokens.

  Store a copy in a password manager. **If it's lost, every stored connection is unreadable and everyone has to reconnect.**
  → `DAY2_SECRETS_KEY`
- [ ] **Don't reuse the Mac's key.** In local mode day2 generates its own key once, in `.day2-secrets-key` next to the orchestrator (`ensureLocalSecretsKey` in `src/ads/connections.ts`). That file has sat in plain text on a laptop. Production gets a **fresh** key.
- [ ] **Don't put the production key on the Mac.** If `DAY2_SECRETS_KEY` is set locally, it wins over the file, and your local encrypted files stop opening.
- [ ] **Migrating encrypted tokens: not needed, and not possible.** No importer exists (section 13). Production starts empty, and every connection is made again by OAuth in the cloud. Each ciphertext is also bound to its row id (as associated data), so copying values between stores would not work even with the same key.

---

## 5. Signing in and GitHub

People need at least one way in. Set up the ones you want, and the login page shows only those. Full click-by-click steps are in [deploy-hetzner.md §3](deploy-hetzner.md#3-ways-to-sign-in).

- [ ] **Email links** (recommended, since it works for everyone). Any transactional SMTP provider (Postmark, SES, Brevo, Mailgun), with SPF and DKIM verified for your domain. The same settings also send invitations.
  - Locally without `SMTP_URL`, emails are only printed to the log.
  - In production, email sign-in is hidden if `SMTP_URL` is missing.
  → `SMTP_URL` (`smtp://user:pass@host:587` or `smtps://…:465`), `MAIL_FROM` (default `day2 <no-reply@localhost>`, so set it)
- [ ] **Google sign-in** (optional). A Google Cloud OAuth client, type Web application. Publish the consent screen; it starts in Testing.
  - Redirect URI: `https://<domain>/api/auth/google/callback`
  → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- [ ] **day2's GitHub App** (required in practice). One App does both GitHub sign-in and repo access.
  - Callback URL: `https://<domain>/api/auth/github/callback`
  - Permissions: Contents, Pull requests and Issues: read & write; Email addresses: read. Request OAuth during installation. Webhook off. Installable by any account.
  - **Not checked at startup:** without the App, the server starts but nobody can connect a repo.
  - Put the private key in `.env` on one line (`awk` command in deploy-hetzner §4), or mount the `.pem` and use `GITHUB_APP_PRIVATE_KEY_FILE`.
  → `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (or `GITHUB_APP_PRIVATE_KEY_FILE`)
- [ ] **Operators.** A comma-separated list of the GitHub usernames who run day2. Only they see the **Platform** page, where day2's own accounts are connected.
  - Locally everyone is the operator.
  - In production, an empty list means nobody is.
  → `DAY2_OPERATOR_LOGINS`

### How git and pull requests work in accounts mode

- **No `gh auth login` on the server.** Don't put a personal token there either.
  - The image ships `git` and `gh`.
  - Every git or gh call goes through `gitEnv()` (`src/tenant.ts`), which calls `githubEnv()` (`src/github-app.ts`). It mints a one-hour **installation token** for the account that owns the repo and hands it over as `GH_TOKEN`. Git uses it through `gh auth git-credential`.
  - Tokens are cached until 5 minutes before expiry and never stored.
- **Connect GitHub (once per account).** A customer installs the App on their user or org and picks repos. day2 clones them into `managed-repos/<accountId>/<appId>` on the `managed-repos` volume.
- **Pull requests.** `gh pr create` (`src/pr.ts`) runs with that account's token.
- **Commit identity.** Commits are authored as `day2 <bot@day2.dev>`, set in the Dockerfile.
- **Contrast with local mode.** There is no installation, so git and gh use **your Mac's own** `gh` login and git config.
- **New-app repos (Lovable path only):** `DAY2_GITHUB_OWNER` puts them under an org. That feature is off (section 11).

---

## 6. Ad platforms: day2's developer apps

Only day2's **developer-app keys** go in the environment. Every ad account that someone connects (day2's own or a customer's) is stored encrypted in Postgres (`ad_connections`). Details are in [ads.md](ads.md#connecting-one-click).

For **each** platform you want:

- [ ] Create the developer app under day2's business account.
- [ ] Add the redirect URL **`https://<domain>/api/ads/connect/callback/<platform>`**, where `<platform>` is one of `meta`, `tiktok`, `google`, `linkedin`, `snapchat`, `pinterest`, `reddit`, `x`. If you registered the tunnel host before, keep it or replace it.
- [ ] Put the keys in `.env`.
- [ ] Apply for the platform's ads API access or app review (table below). Until a platform approves the app, usually only accounts you own (or listed testers) can connect.

| Platform | Env vars (keys) | Access to request (check the platform's current process; day2's code doesn't automate this) |
|---|---|---|
| Meta | `META_APP_ID`, `META_APP_SECRET`, `DAY2_META_BUSINESS_ID` (for Page access requests) | Business verification, plus App Review for Advanced Access to `ads_management`, `ads_read` and `business_management`. For the Page step: `pages_show_list` and related Page scopes |
| TikTok | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | TikTok for Business developer app, approved for the Marketing API. Approval is a manual review and can take days |
| Google | `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, optional `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | OAuth consent-screen verification for the `adwords` (and `datamanager`) scopes. Enable the Google Ads API and the **Data Manager API** in the Cloud project. Per the code, developer tokens were sunset on 2026-09-09 and are optional |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, optional `LINKEDIN_API_VERSION` | Advertising API product access on the LinkedIn developer app |
| Snapchat | `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET` | Marketing API OAuth app in Snap Business Manager |
| Pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | Ads API access (trial, then standard) |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, optional `REDDIT_USER_AGENT` | Reddit Ads API access. The same three vars also switch on Reddit trend research (`src/growth-trend-sources.ts`) |
| X | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET` | X Ads API access application. Register the callback URL without a query string (OAuth 1.0a) |

- [ ] **Check.** On **Platform → Ad accounts**, a platform missing keys lists the missing names. Customers see "Not available yet".
- [ ] **Switch a platform off without removing its keys:** `DAY2_ADS_DISABLE=reddit,x`.
- [ ] **Status:** every adapter is **built, not verified** against a live ad account ([ads.md](ads.md#whats-verified-and-what-isnt)). Run one small campaign per platform from a test app before relying on it.

### day2's own ad accounts (the operator)

- [ ] **Connect day2's ad accounts.** On **Platform → Ad accounts**, connect day2's own account on each platform. Customers' ad spend runs here by default and is billed to them in credits. The same page checks the server: https address, encryption key, ffmpeg, Chromium and Creatify.
- [ ] **Connect day2's tool accounts.** On **Platform → Tools**, connect Foreplay, Runway and Meta Ads. These are MCP connectors used for research and video.
  - Their OAuth comes back to `https://<domain>/api/connectors/callback`.
  - Tools without dynamic client registration take `DAY2_CONNECTOR_<ID>_CLIENT_ID` / `_CLIENT_SECRET`.
  - `DAY2_CONNECTOR_<ID>_MCP_URL` overrides the server address (e.g. `DAY2_CONNECTOR_FOREPLAY_MCP_URL`).
- [ ] **Facebook Pages.** Meta needs one per app. Create it in day2's Meta Business account and enter its id on **Platform → Facebook Pages for ads** (deploy-hetzner §5.6).
- [ ] **Older env-based accounts** (optional; connecting on the Platform page replaces them): `META_ACCESS_TOKEN` + `DAY2_META_AD_ACCOUNT_ID` (+ `DAY2_META_DSA_PAYOR`), `TIKTOK_ACCESS_TOKEN` + `TIKTOK_ADVERTISER_ID`, `GOOGLE_ADS_REFRESH_TOKEN` + `GOOGLE_ADS_CUSTOMER_ID`, `LINKEDIN_REFRESH_TOKEN` + `LINKEDIN_AD_ACCOUNT_ID`, `SNAP_REFRESH_TOKEN` + `SNAP_AD_ACCOUNT_ID`, `PINTEREST_REFRESH_TOKEN` + `PINTEREST_AD_ACCOUNT_ID` (+ `PINTEREST_BOARD_ID`), `REDDIT_REFRESH_TOKEN` + `REDDIT_AD_ACCOUNT_ID` (+ `REDDIT_FUNDING_INSTRUMENT_ID`), `X_ACCESS_TOKEN` + `X_ACCESS_TOKEN_SECRET` + `X_ADS_ACCOUNT_ID` (+ `X_FUNDING_INSTRUMENT_ID`). See the table in [ads.md](ads.md#platforms).
  - **Watch out:** the Growth page's "Meta connected" flag still looks for `DAY2_META_AD_ACCOUNT_ID` (`src/api-server.ts`). Set it even if you connected Meta on the Platform page.
- [ ] **Not built yet, don't set:** `DAY2_META_ADS_ACCESS_TOKEN`, `DAY2_GOOGLE_ADS_REFRESH_TOKEN` and `DAY2_TIKTOK_ADS_ACCESS_TOKEN` (`src/external-ingest.ts`). They are placeholders and report "not implemented" even when set.

---

## 7. Ad creative: video and media

- [ ] **ffmpeg and Chromium.** Already in the Docker image. They're used for walkthrough and motion videos and the daily simulation. Override paths only if you know you need to.
  → `FFMPEG_PATH`, `FFPROBE_PATH`, `PW_CHROMIUM_PATH`
- [ ] **Creatify** (AI presenter videos, optional). An API plan at creatify.ai.
  → `CREATIFY_API_ID`, `CREATIFY_API_KEY`; optional `CREATIFY_USD_PER_CREDIT` (default $0.198), `CREATIFY_AVATAR_ID`, `CREATIFY_VOICE_ID`, `CREATIFY_SCRIPT_STYLE`, `CREATIFY_VISUAL_STYLE`
- [ ] **Runway** (generated motion shots, optional, off by default). An API key from dev.runwayml.com.
  → `RUNWAYML_API_SECRET`, `DAY2_ADS_RUNWAY=on`; optional `RUNWAY_MODEL`, `RUNWAY_USD_PER_CREDIT`
- [ ] **Trend research** (optional). Without these keys the research runs without that source and says so.
  → `YOUTUBE_API_KEY` (Google Cloud, YouTube Data API v3), and Reddit's three vars (section 6)

---

## 8. Errors from customers' apps (Sentry)

- [ ] **Sentry token** (optional). It pulls unresolved issues into a backlog when an app's settings name a Sentry org and project.
  - **Where:** sentry.io → Settings → Auth Tokens, scoped to read issues.
  → `SENTRY_AUTH_TOKEN`, `SENTRY_REGION_URL` (default `https://sentry.io`; use e.g. `https://de.sentry.io` for the EU region)
  - **Limitation:** this is **one server-wide token**. In accounts mode it can only read Sentry orgs that *day2's* token can see. There is no per-customer Sentry connection yet (**not built yet**).

---

## 9. Payments and credits

- [ ] **Payments: not built yet.** Plans and credit top-ups exist (`src/credits.ts`). New workspaces get a 14-day trial. But no payment provider is wired up: the code returns `paymentsConnected: false`, and plan changes and top-ups are written straight to the ledger.
  - **In production, an owner can give themselves a paid plan for free.** Decide how you'll handle that before inviting paying customers: invite only, or build Stripe first.
- [ ] **Not built yet, don't set:** `DAY2_STRIPE_SECRET_KEY`, `DAY2_APPLE_IAP_SHARED_SECRET` and `DAY2_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (`src/external-ingest.ts`). They're placeholders for reading *customers'* revenue, not for billing customers.

---

## 10. Mobile releases and device checks

### Mobile releases (EAS)

- [ ] **Nothing to install.** The image has Node 22 and **eas-cli 27.2.0**, pinned in both the `Dockerfile` and `EAS_CLI_VERSION` in `src/mobile-release/eas.ts`. If `eas` were missing, day2 would fall back to `npx eas-cli@27.2.0`.
- [ ] **No server credentials.** Each app's owner connects on **Releases**:
  - an Expo robot token (passed to eas as `EXPO_TOKEN` and to nothing else);
  - an App Store Connect API key;
  - a Google Play service account.

  These are stored encrypted (`release_credentials`). Builds run on EAS's machines, so no Mac is needed on the server. See [mobile-releases.md](mobile-releases.md) and [store-privacy.md](store-privacy.md).
- [ ] **Status: built, not verified.** Run one release of a test app through the over-the-air update path and one through the store path.

### Device checks in the cloud

- **Local mode:** before opening a pull request for a mobile app, day2 runs the changed app with **Maestro** on your Mac's **iOS Simulator** (and the **Android emulator** if one is installed). It walks the app's flows plus one written for the change, keeps before/after screenshots, and blocks the PR on a crash, a failed flow or an app that doesn't start.
- **Deployed:** the server has no simulators. Instead:
  - [ ] Set `DAY2_DEVICE_CHECKS=eas`.
  - [ ] Each app's owner connects their Expo account on the **Releases** page (the same Expo token as releases).
  - Checks then run as **EAS Workflows**: Maestro on EAS's simulators and emulators. The results and a link come back to day2.
  - **Cost:** this uses the **app owner's Expo build minutes**, not day2's.
- **Status: built, not yet verified end to end.** How it works, and the local setup: [device-checks.md](device-checks.md).

---

## 11. Optional and off-by-default features

- [ ] **Creating apps with Lovable.** Keep it off until Lovable confirms the use (`.env.example`).
  → `DAY2_FEATURE_CREATE_APPS=off`
  - If you ever turn it on: `DAY2_LOVABLE_API_KEY`, `DAY2_LOVABLE_MCP_URL`, `DAY2_LOVABLE_CREDITS_PER_BUILD`, `DAY2_LOVABLE_USD_PER_CREDIT`, `DAY2_GITHUB_OWNER`.
- [ ] **Weekly growth digest to Slack.** Only used by the `growth-digest` CLI, not by the server.
  → `DAY2_SLACK_WEBHOOK_URL`

---

## 12. Background work, backups, updates

- [ ] **Timer.** There is no cron and no separate worker. The API process runs one timer every `DAY2_BACKLOG_TICK_MINUTES` (default 15; `0` turns it off). Each pass does, in order:
  1. growth autopilot for every app (`autopilotAll`), which includes the ad pass;
  2. the backlog pass (`tickAll`): import findings, re-rank, settle PRs, sync JIRA/Linear, start allowed work, mobile releases;
  3. the daily simulation (`simulateAll`);
  4. once a day, it prunes old field reports.

  In accounts mode a Postgres advisory lock makes sure only one server runs each pass. Each workspace's work runs as that workspace and is paid from its credits.
  → `DAY2_BACKLOG_TICK_MINUTES`
- [ ] **Nightly backups.** The `backup` service runs `deploy/backup.sh` every night at `BACKUP_HOUR` (UTC, default 03) and keeps `BACKUP_KEEP_DAYS` days (default 14) in `deploy/backups/`. Each night produces:
  - `pg_dump` of the database;
  - the `day2-*.json(l)` files from every checkout;
  - `/data` (ad assets, field data, and so on).

  To run one now: `docker compose run --rm backup /backup.sh --once`.
  → `BACKUP_HOUR`, `BACKUP_KEEP_DAYS`
- [ ] **Off-server copies: not automated.** Set up `rclone sync` to a Storage Box, or turn on Hetzner backups (deploy-hetzner, "Backups off the server"). Practise a restore once.
- [ ] **Updating.** `git pull` both repos, then `docker compose up -d --build`. Migrations apply on start.

---

## 13. Moving the demo data

**There is no importer.** Nothing in the code reads local-mode files into Postgres. Production starts empty: customers sign up, connect GitHub and add their apps again.

What exists locally, and where it lives in accounts mode:

| Local file (next to the orchestrator unless noted) | What it is | In accounts mode |
|---|---|---|
| `.day2-apps.json` | Your apps registry | Postgres (`apps`, per account) |
| `.day2-credits-account.json`, `.day2-credits-ledger.jsonl` | Your plan, balance and ledger | Postgres, per account |
| `.day2-integrations.json` | JIRA and Linear connections | Postgres (encrypted) |
| `.day2-connectors.json`, `.day2-ad-connections.json`, `.day2-ads-tokens.json`, `.day2-release-credentials.json` | Connected tools, ad accounts, rotated ad tokens, release credentials (encrypted with `.day2-secrets-key`) | Postgres, encrypted with the new key. Reconnect each one |
| `.day2-ad-identities.json`, `.day2-platform-identities.json`, `.day2-ad-conversions-sent.json` | Ad identities and sent conversions | Postgres |
| `.day2-ingest-keys.json`, `field/` | Apps' report keys, and what devices reported | Postgres. **New keys** (see below) |
| `ad-assets/`, `.day2-fx.json`, `.day2-lovable*.json` | Ad images and videos, exchange-rate cache, Lovable account | Files under `/data` (`DAY2_DATA_DIR`) |
| `managed-repos/` | App checkouts | `managed-repos/<accountId>/<appId>` on the volume, cloned again through the GitHub App |
| `day2-*.json` / `day2-*.jsonl` **inside each app's checkout** (`day2-backlog.json`, `day2-growth-bets.json`, `day2-autopilot-log.jsonl`, `day2-mobile-releases.json`, `day2-retention.json`…) | Each app's backlog, growth, ads and release state | **Still files** in the app's checkout. Not Postgres |

If you want to keep a demo app's history, do it by hand. This hasn't been tested.

- [ ] Add the app in production, so it gets its new account and app id.
- [ ] Stop the api.
- [ ] Copy that app's `day2-*.json(l)` files from your Mac's checkout into `managed-repos/<accountId>/<appId>/` on the volume. Use the same `docker compose run … tar` approach as the restore in deploy-hetzner.
- [ ] Start the api.

Do **not** copy any `.day2-*` file from the orchestrator folder, and never copy `.day2-secrets-key`.

- [ ] **Apps already reporting to your Mac.** Apps that ship the field library have the *local* report endpoint (your tunnel host) and the *local* key built in (`EXPO_PUBLIC_DAY2_ENDPOINT`, `EXPO_PUBLIC_DAY2_KEY`). After re-adding the app in production, it needs the production endpoint (`https://<domain>`) and its new key, and that change has to ship in a new release. Until then its reports go to the old address.

---

## 14. First day after deploy: smoke test

Do these in order, with a test app that you own.

- [ ] `docker compose logs api` shows `[day2-api] accounts mode, listening …` and no `Production needs …` error.
- [ ] **Sign in** at `https://<domain>` with each way you set up. The email link arrives, and not in spam.
- [ ] Your user sees **Platform**. If not, check `DAY2_OPERATOR_LOGINS`.
- [ ] **Sandbox check:** `docker compose exec api bwrap --unshare-all --ro-bind / / true && echo sandbox ok`
- [ ] **Add an app:** Connect GitHub, install the App, pick a repo. It's cloned under `managed-repos/<accountId>/`.
- [ ] **The backlog tick runs:** within `DAY2_BACKLOG_TICK_MINUTES`, the app's backlog and Growth log show activity, and the logs have no `[day2-backlog] tick failed`. For a quick check, use **Refresh** on the backlog.
- [ ] **A PR gets opened:** start a small ticket. A pull request appears on GitHub, opened by the day2 App with day2 as author, and its credits show up in the ledger.
- [ ] **Ads connect callback works:** on **Platform → Ad accounts**, connect one platform. You go to the platform's sign-in, come back to `/api/ads/connect/callback/<platform>`, and can pick an account. A "redirect_uri mismatch" means the developer app is missing the production URL.
- [ ] **Media is reachable:** an `/api/assets/…` URL from a made ad opens from your phone on mobile data.
- [ ] **Field ingest receives a report:** with a test build pointing at `https://<domain>` and the app's new key, open the app, and the app's field data in the console shows the launch (`POST /api/ingest/<key>`).
- [ ] **Backups:** run `docker compose run --rm backup /backup.sh --once`, and three files appear in `deploy/backups/`.
- [ ] **Credits:** a workspace on the trial can't start work beyond its credits. And remember that paid plans aren't actually charged yet (section 9).
