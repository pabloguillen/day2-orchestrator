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
  - owners' one-hour Google tokens during "Connect your stores" (deleted after setup);
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
- [ ] **Google for "Connect your stores"** (recommended). Customers sign in with Google once per app and day2 sets up their Google Cloud project, service account, Pub/Sub and Android push ([connect.md](connect.md)). A Web application OAuth client in day2's Google Cloud project — the sign-in client above works too (then add the second redirect URI and the scopes to it).
  - Redirect URI: `https://<domain>/api/ads/connect/callback/googlecloud` (locally also the tunnel host's; the tunnel allowlist already covers the path).
  - Scopes on the consent screen: `openid`, `email`, `.../auth/cloud-platform`, `.../auth/androidpublisher`. Both are **sensitive**: Google's verification of the consent screen can take weeks, and until then only listed test users can sign in. Start it early (go-live checklist).
  - No refresh token is asked for; the owner's token lives encrypted for at most an hour and is revoked when setup ends, a sign-in fails or is cancelled, or the hour is up (backlog timer). PKCE and a single-use state guard the callback (migrations `024_connect.sql`, `025_connect_pkce.sql`).
  - **Check:** Platform → Connect your stores lists what's missing.
  → `DAY2_GOOGLE_OAUTH_CLIENT_ID`, `DAY2_GOOGLE_OAUTH_CLIENT_SECRET` (falls back to `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`)
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
- **New-app repos (Lovable and Expo Create):** `DAY2_GITHUB_OWNER` puts them under an org. Both create the repo with the machine's `gh` login, which a deployed server doesn't have: there, a newly created app stays a repository on the server until repo creation through the GitHub App is built ([expo-apps.md](expo-apps.md), "Not verified / not built").

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
| Meta | `META_APP_ID`, `META_APP_SECRET`, `DAY2_META_BUSINESS_ID` (for Page access requests), optional `META_API_VERSION` | Business verification, plus App Review for Advanced Access to `ads_management`, `ads_read` and `business_management`. For the Page step: `pages_show_list` and related Page scopes. For Social (posting): `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `read_insights` ([operator-setup.md](operator-setup.md) §2f, [social.md](social.md)) |
| TikTok | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | TikTok for Business developer app, approved for the Marketing API. Approval is a manual review and can take days |
| TikTok posting (Social) | `TIKTOK_CONTENT_CLIENT_KEY`, `TIKTOK_CONTENT_CLIENT_SECRET`, optional `TIKTOK_CONTENT_API_BASE` | A separate app on developers.tiktok.com with Login Kit + Content Posting API (Direct Post), scopes `user.info.basic`, `video.publish`, `video.upload`, `video.list`, redirect `https://<domain>/api/ads/connect/callback/tiktokposts`. Until TikTok's audit, posts are private only ([operator-setup.md](operator-setup.md) §3d) |
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
- [ ] **Facebook Pages.** Meta needs one per app. Create it in day2's Meta Business account and pick it (or enter its id) on **Platform → Facebook Pages for ads** (deploy-hetzner §5.6). The list comes from day2's Meta connection, which now also asks for `pages_show_list` — reconnect Meta once. An owner who picks their Page after Facebook sign-in on Ads sets the same value.
- [ ] **Older env-based accounts** (optional; connecting on the Platform page replaces them): `META_ACCESS_TOKEN` + `DAY2_META_AD_ACCOUNT_ID` (+ `DAY2_META_DSA_PAYOR`), `TIKTOK_ACCESS_TOKEN` + `TIKTOK_ADVERTISER_ID`, `GOOGLE_ADS_REFRESH_TOKEN` + `GOOGLE_ADS_CUSTOMER_ID`, `LINKEDIN_REFRESH_TOKEN` + `LINKEDIN_AD_ACCOUNT_ID`, `SNAP_REFRESH_TOKEN` + `SNAP_AD_ACCOUNT_ID`, `PINTEREST_REFRESH_TOKEN` + `PINTEREST_AD_ACCOUNT_ID` (+ `PINTEREST_BOARD_ID`), `REDDIT_REFRESH_TOKEN` + `REDDIT_AD_ACCOUNT_ID` (+ `REDDIT_FUNDING_INSTRUMENT_ID`), `X_ACCESS_TOKEN` + `X_ACCESS_TOKEN_SECRET` + `X_ADS_ACCOUNT_ID` (+ `X_FUNDING_INSTRUMENT_ID`). See the table in [ads.md](ads.md#platforms).
  - The Growth page's "Meta connected" flag is true with a Meta ad account connected on the Platform page or for the app; `DAY2_META_AD_ACCOUNT_ID` is no longer needed for it.
- [ ] **Not built yet, don't set:** `DAY2_META_ADS_ACCESS_TOKEN`, `DAY2_GOOGLE_ADS_REFRESH_TOKEN` and `DAY2_TIKTOK_ADS_ACCESS_TOKEN` (`src/external-ingest.ts`). They are placeholders and report "not implemented" even when set.

---

## 7. Ad creative: video and media

- [ ] **ffmpeg and Chromium.** Already in the Docker image. They're used for walkthrough and motion videos and the daily simulation. Override paths only if you know you need to.
  → `FFMPEG_PATH`, `FFPROBE_PATH`, `PW_CHROMIUM_PATH`
- [ ] **Creatify** (AI presenter videos, optional). An API plan at creatify.ai.
  → `CREATIFY_API_ID`, `CREATIFY_API_KEY`; optional `CREATIFY_USD_PER_CREDIT` (default $0.198), `CREATIFY_AVATAR_ID`, `CREATIFY_VOICE_ID`, `CREATIFY_SCRIPT_STYLE`, `CREATIFY_VISUAL_STYLE`
- [ ] **Runway** (generated motion shots, optional, off by default). An API key from dev.runwayml.com.
  → `RUNWAYML_API_SECRET`, `DAY2_ADS_RUNWAY=on`; optional `RUNWAY_MODEL`, `RUNWAY_USD_PER_CREDIT`
- [ ] **More creator tools** (optional; [creator-tools.md](creator-tools.md)). day2's own account for each; owners can turn them on per app ("Use day2's", billed in credits, monthly cap) or connect their own keys instead.
  → HeyGen (presenter videos): `HEYGEN_API_KEY`; optional `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`, `HEYGEN_ENGINE`, `HEYGEN_USD_PER_SECOND`
  → Luma (generated clips): `LUMA_API_KEY`; optional `LUMA_MODEL`, `LUMA_RESOLUTION`, `LUMA_USD_PER_CREDIT`
  → Google, Gemini Omni (generated clips): `GEMINI_API_KEY`; optional `GEMINI_VIDEO_MODEL`, `GEMINI_VIDEO_USD_PER_SECOND`
  → ElevenLabs (voiceovers, music): `ELEVENLABS_API_KEY`; optional `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`, `ELEVENLABS_USD_PER_1K_CHARS`, `ELEVENLABS_USD_PER_MUSIC_MINUTE`
  → OpenAI Images (image backgrounds): `OPENAI_API_KEY`; optional `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_USD_PER_IMAGE`
  → Owners' own keys are stored encrypted with `DAY2_SECRETS_KEY` (section 4).
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
- [ ] **No server credentials** beyond the Google OAuth client (section 5). Each app's owner connects on **Connect your stores** ([connect.md](connect.md)):
  - an Expo robot token (passed to eas as `EXPO_TOKEN` and to nothing else);
  - an App Store Connect API key (the `.p8`; Key ID read from the file name);
  - Google Play: **Sign in with Google** creates the service account and its key (or the owner pastes a key when the server has no Google client).

  These are stored encrypted (`release_credentials`), as before; the Releases API still accepts them. Builds run on EAS's machines, so no Mac is needed on the server. See [mobile-releases.md](mobile-releases.md) and [store-privacy.md](store-privacy.md).
- [ ] **Status: built, not verified.** Run one release of a test app through the over-the-air update path and one through the store path.

### Device checks in the cloud

- **Local mode:** before opening a pull request for a mobile app, day2 runs the changed app with **Maestro** on your Mac's **iOS Simulator** (and the **Android emulator** if one is installed). It walks the app's flows plus one written for the change, keeps before/after screenshots, and blocks the PR on a crash, a failed flow or an app that doesn't start.
- **Deployed:** the server has no simulators. Instead:
  - [ ] Set `DAY2_DEVICE_CHECKS=eas`.
  - [ ] Each app's owner connects their Expo account on the **Releases** page (the same Expo token as releases).
  - Checks then run as **EAS Workflows**: Maestro on EAS's simulators and emulators. The results and a link come back to day2.
  - **Cost:** this uses the **app owner's Expo build minutes**, not day2's.
- **Status: built, not yet verified end to end.** How it works, and the local setup: [device-checks.md](device-checks.md).
- [ ] **To build before going public: [e2e by TesterArmy](https://github.com/tester-army/e2e)** (Apache-2.0, pre-1.0) as the cloud test runner next to Maestro. Expo documents it ([guide](https://docs.expo.dev/guides/using-e2e/)), including EAS Workflows and Expo Simulators.
  - **Runner:** if an app has `e2e.config.ts`, the EAS device-check workflow runs `npx e2e run --config e2e.ci.config.ts` on an iOS Simulator build (`ios.simulator: true` profile). day2 reads `.e2e/report.json` and shows the failure screenshots and `screen.txt` from `.e2e/artifacts/` with the change. Apps without it keep using Maestro.
  - **Tests:** the build agent writes exact-step tests (`tests/day2/*.e2e.ts`: locators and `expect`, one `app.open()` per test). It can use e2e's MCP server to look at the running app while writing them.
  - **No agent steps:** e2e's `agent.act()` needs its own model (ChatGPT/Copilot/Grok subscription, an API key or a local model). It can't use the Claude subscription, and the deployed server has `ANTHROPIC_API_KEY` for day2's own agents only. Decide then whether agent steps are worth a model key. Exact steps need no model.
  - **Setup per app:** day2 opens one PR that adds `e2e`, `@e2e-dev/mobile`, the configs and a first start-screen test.
  - **Settings:** set `E2E_TELEMETRY_DISABLED=1` on the workers. Pin the e2e version, because its config can change between minor releases. Before/after screenshots stay day2's own, since e2e takes screenshots only on failure.

### Live: settings and experiments over the air

- [ ] **Nothing to set on the server.** Live needs no keys or accounts. Apps fetch their config from `/api/ingest/<key>/config` on day2's public address, and the migration `012_live.sql` (applied on start) adds its tables. See [live.md](live.md).
- [ ] **Each app gets one "Native foundations" ticket** (expo-updates, AsyncStorage, expo-application, plus what Money and Messages need). It has to reach users in one store release before experiments that need new settings can run.
- [ ] **Credits:** experiment ideas and "describe an experiment" are agent runs paid from the workspace's credits (`agent_work`, at most $1 each). Ideas come every 14 days at most.
- [ ] **Status: built and tested with fakes, not verified on a phone.** Run one settings-only experiment on a test app (Dotty) end to end: set a value, see it on the next launch, start an experiment, watch the exposures arrive.

### Push notifications and in-app messages (Messages)

- [ ] **No server settings.** day2 sends through Expo's push service with each app's Expo token, the one connected on **Releases**. Tokens, campaigns and send records are in Postgres (`016_messages.sql`: `push_tokens`, `message_optouts`, `message_sends`, `app_messages`). Locally they're files under `<data>/messages/`.
- [ ] **Outbound HTTPS to `exp.host`** must be allowed from the server.
- [ ] **Per app:** for Android, Sign in with Google on Connect your stores sets up Firebase and uploads the FCM V1 key to EAS (with Expo connected); `google-services.json` arrives with a ticket. iOS needs nothing in most cases. See [messages.md](messages.md), "What the owner sets up".
- [ ] **Ingest:** the app sends its push token to `POST /api/ingest/<key>/push`. It's public like the other ingest routes. The inbox Worker keeps these POSTs while day2 is away and replays them later (Live owns that route).
- **Local mode:** pushes wait while the Mac sleeps. They go at the next good local time, or are skipped after 30 hours.
- **Status: built, not verified** against a real Expo project and real devices.

### Money: purchases, ads and prices

- [ ] **Nothing to set on the server** beyond `DAY2_PUBLIC_URL` (https) and `DAY2_SECRETS_KEY`. Migration `015_money.sql` (applied on start) adds the ledger, the notification queue and Money's encrypted keys. See [money.md](money.md).
- [ ] **Public webhooks:** `/api/store-notify/apple/<app>` and `/api/store-notify/google/<app>` must be reachable from Apple and Google (they're in the tunnel allowlist and buffered by the inbox Worker). Apps that already use RevenueCat use `/api/store-notify/revenuecat/<app>` — **add that path to the tunnel allowlist and the Worker** if such an app is onboarded (not done yet).
- [ ] **Per app, the owner** signs Apple's Paid Apps agreement and Google's payments profile, adds the In-App Purchase key (Connect your stores or Money), enters the Pub/Sub topic in Play Console's Monetization setup, and an AdMob account if the plan has ads. day2 creates the Pub/Sub topic and push itself after Sign in with Google, and sets Apple's notification URL through the App Store Connect API ("Set it for me").
- [ ] **Credits:** a plan ("how the app earns") is an agent run paid from credits (`scan_answer`, at most $2), every 60 days or when users grow 5×.
- [ ] **Status: built and tested with fakes, not verified against real Apple/Google accounts.** First real check on Dotty: create the In-App Purchase key, set the server notification URL, press "Send a test notification", buy the subscription with a sandbox account in TestFlight and watch it arrive as a sandbox record.

### Store: listing, screenshots, tests and reviews

- [ ] **Nothing new to set on the server.** Store uses the App Store Connect key and Google Play service account each app connected on Releases, and Apple's public iTunes Search API. The migration `013_store_listing.sql` (applied on start) adds `store_listing` and `store_reviews`. See [store-listing.md](store-listing.md).
- [ ] **Screenshots need a Mac** (iPhone Simulator, Android emulator, Maestro): local mode only. A deployed day2 shows "This server can't run simulators" and skips them.
- [ ] **Credits:** research (at most about $1.10 a run, every 30 days or after a release), review replies and problems (at most $0.90 every 6 hours, only when there are new reviews) and captions are paid from the workspace's credits.
- [ ] **Status: built and tested with recorded responses, not verified against a real App Store Connect or Play account.** On Dotty, check: reading the listing, one promotional-text change, a staged subtitle going out with the next version, one review reply, and the 6.9" screenshot type. The list of unverified calls is in [store-listing.md](store-listing.md).

### Store setup: day2 fills out App Store Connect and Google Play

- [ ] **`DAY2_SECRETS_KEY` must be set** (section 4): the App Review demo account is encrypted with it. Without it the console says so and the account can't be saved.
- [ ] **The App Store Connect key needs the App Manager role** (as for releases): pricing, availability, age rating and App Review details are App Manager calls. The Play service account needs "Manage store presence" and "Edit app information" (Play Console → Users and permissions).
- [ ] **No migration.** Setup lives in the `store_listing` document. Play graphics and previews are files under `/data/store-setup/`.
- [ ] **The Play icon and feature graphic are rendered with Chromium** (Playwright, as for screenshots and mockups). The Docker image already has it.
- [ ] **App previews need a Mac in local mode**: Xcode's iPhone Simulator, Maestro and **ffmpeg** (`brew install ffmpeg`). A deployed day2 shows previews as "not needed" and skips them.
- [ ] **Credits:** one agent run per app reads the code for the setup answers (at most $0.80, once; retried a day later if it fails).
- [ ] **Status: built and tested with recorded responses, not verified against real accounts.** On Dotty, check: categories and content rights, the privacy links, support link and copyright on a version being prepared, the age rating (which of the 2025 questions Apple takes through the API), App Review details with a demo account, the free price and availability for a brand-new app, one app preview upload, and on Play the details, the icon and feature graphic. The list is in [store-listing.md](store-listing.md#not-verified-against-real-accounts).

### Numbers: installs, users, money and quality per app

- [ ] **Nothing new to set on the server.** Numbers reads the App Store Connect key and Google Play service account each app connected on Releases. Migration `018_numbers.sql` (applied on start) adds `numbers_cache` and a `platform` column on `field_events` (older events show as "not reported"). See [numbers.md](numbers.md).
- [ ] **When it runs:** once a day per app, after the growth autopilot on the backlog timer (`DAY2_BACKLOG_TICK_MINUTES`; 0 turns it off), and when the owner presses Refresh (at most every 10 minutes per app). The first pass reads up to 180 days of daily sales (one request per day), so it takes a few minutes per app.
- [ ] **Network:** the server must reach `api.appstoreconnect.apple.com`, Apple's report download host, `storage.googleapis.com`, `oauth2.googleapis.com` and `playdeveloperreporting.googleapis.com`.
- [ ] **Per app, the owner** pastes the Apple vendor number on Connect your stores (checked with Apple). Sign in with Google turns on the Play Developer Reporting API, invites the service account with "View app information and download bulk reports" and finds the reports bucket when it can (else one paste). App Analytics needs an Admin key once — dropped on Connect your stores, used once, not kept.
- [ ] **Credits:** none — Numbers only reads.
- [ ] **Status: built and tested with recorded files, not verified against a real App Store Connect or Play account** (list in numbers.md).

### Hosting: apps' backends on Supabase

- [ ] **day2's Supabase organization** on the Pro plan or higher (Free projects pause after a week and have no backups or branching). See [hosting.md](hosting.md), "Operator setup".
  → `SUPABASE_ACCESS_TOKEN` (a personal access token of an Owner of that organization, ideally a robot account), `DAY2_SUPABASE_ORG_ID` (the slug)
- [ ] **An email sender for apps' sign-in emails** — Supabase's own reaches only the organization's team, 2 an hour.
  → `DAY2_HOSTING_SMTP_URL=smtp://user:pass@host:587`, `DAY2_HOSTING_SMTP_FROM`
- [ ] **Connection test:** `docker compose exec api bun run src/hosting/operator.ts` (locally `bun run src/hosting/operator.ts`) prints the organization, plan and branching.
- [ ] **Outbound HTTPS** to `api.supabase.com`, `*.supabase.co`, `appleid.apple.com` and `oauth2.googleapis.com` (sign-in connection tests), and npm for the CLI fallbacks (`npx supabase@2.122.1`, `npx eas-cli@27.2.0`).
- [ ] Migration `021_hosting.sql` (applied on start) adds `app_hosting` and `hosting_secrets` (encrypted with `DAY2_SECRETS_KEY`).
- [ ] Optional: `DAY2_HOSTING_DEFAULT_REGION` (eu-central-1), `DAY2_HOSTING_INSTANCE_SIZE` (micro), `DAY2_FEATURE_HOSTING=off`.
- [ ] **Credits:** each app's daily Supabase cost is charged as "Hosting" (`infra`); check the rates in `src/hosting/operations.ts` (`RATES`) against Supabase's current prices.
- [ ] **Status: built and tested with fakes, not verified against a real Supabase organization.** Host one test app end to end first (hosting.md, "What's verified and what isn't").
### What day2 knows and what works (memory and learning)

- [ ] **Database:** migrations `022_memory.sql` (`memory_items`, `memory_state`) and `023_learning.sql` (`learning_outcomes`, `learning_playbook`, `learning_failures`, `learning_fp_candidates`, `learning_settings`) run by themselves at start. See [memory-and-learning.md](memory-and-learning.md).
- [ ] **The salt for app hashes** in the shared library comes from `DAY2_SECRETS_KEY` (already required). Set `DAY2_LEARNING_SALT` only if you want a separate one — and never change it afterwards, or every app would count twice.
- [ ] **When it runs:** the memory keeper on the backlog timer, at most once an hour per app (plus right after a decline with a reason or an answer), as a short text-only run paid from the customer's credits (Scans & answers). `DAY2_MEMORY_MODEL` picks a cheaper model if you have one; default `DAY2_MODEL`.
- [ ] **Operators** (`DAY2_OPERATOR_LOGINS`) review the build playbook and false-positive candidates on Platform → What works across apps. Nothing reaches a build agent before it's approved there.
- [ ] **Customers** can turn cross-app learning off on People & workspace; it's on by default. **Your terms and privacy notice must say so first** (go-live checklist).

---

## 11. Optional and off-by-default features

- [ ] **Creating apps with Lovable.** Keep it off until Lovable confirms the use (`.env.example`).
  → `DAY2_FEATURE_CREATE_APPS=off`
  - If you ever turn it on: `DAY2_LOVABLE_API_KEY`, `DAY2_LOVABLE_MCP_URL`, `DAY2_LOVABLE_CREDITS_PER_BUILD`, `DAY2_LOVABLE_USD_PER_CREDIT`, `DAY2_GITHUB_OWNER`.
- [ ] **Creating native apps with Expo** (`src/expo-create/`, [expo-apps.md](expo-apps.md)). On by default; it needs no third party beyond the owner's own Expo, Apple and Google accounts. Builds are kept in the `expo_creates` table (migration 014; builds from before the screen flow are moved to the new states when read, no new migration) and resumed when the server starts.
  → `DAY2_FEATURE_CREATE_EXPO=off` to hide it; `DAY2_EXPO_TEMPLATE` (e.g. `default@sdk-57`) to pin the Expo SDK.
  - [ ] **Status: built, not verified end to end.** Create one real app on a Mac (screen list → every screen drawn → flow map and prototype → a round of changes → approve → four build steps → repo) before offering it.
  - The server needs Chromium for Playwright (already used for mockups and ads) to draw the screens, the style card and the flow map. The drawings live in `<data>/mockups/<app id>/flow/`; back them up with the data folder.
  - Apps that need a backend (accounts, shared data, uploads, server functions, live updates) are hosted on day2's Supabase organization when Hosting is set up (`SUPABASE_ACCESS_TOKEN`, `DAY2_SUPABASE_ORG_ID`, [hosting.md](hosting.md) "Operator setup"); without it they keep a backend on the phone and get a "Host with day2" follow-up ([expo-apps.md](expo-apps.md), "Hosting").
  - The server image needs `npx` with network access to npm for `create-expo-app` and `npx expo install` (Node 22 is in the image).
- [ ] **Weekly growth digest to Slack.** Only used by the `growth-digest` CLI, not by the server.
  → `DAY2_SLACK_WEBHOOK_URL`

---

## 12. Background work, backups, updates

- [ ] **Timer.** There is no cron and no separate worker. The API process runs one timer every `DAY2_BACKLOG_TICK_MINUTES` (default 15; `0` turns it off). Each pass does, in order:
  1. growth autopilot for every app (`autopilotAll`), which includes the ad pass and the messages pass (due pushes every run, campaigns every 6 hours, measurement daily);
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

## 12a. The inbox at Cloudflare (optional)

Keeps app reports while day2 can't be reached (deploys, outages), then hands them over: [inbox.md](inbox.md). Settings: `DAY2_INBOX_URL`, `DAY2_INBOX_TOKEN`.

It also:

- keeps the last good **Live config** per app and serves it while day2 is away, so apps keep their settings and experiments ([live.md](live.md));
- keeps **push tokens** and **App Store / Google Play notifications** (`/api/store-notify/apple|google/<app>`) like reports, and day2 replays each to its own path.

- [ ] **Run `deploy/inbox/setup.sh` again after updating.** It adds the `live_config` table and the `store-notify` route. Before that, the Worker passes config requests through but keeps no copy.

---

## 12b. What your customers do (and what day2 does for them)

Once day2 is deployed, an app owner never touches tunnels, addresses or keys for day2 itself. Their part:

| Step | Who |
|---|---|
| day2 in the app | **day2.** A pull request adds it ("Install day2 field checks"). For an app that wired day2 in by hand with env variables, a pull request sets them in `eas.json` ("Turn on day2 in release builds"). The owner approves. |
| Privacy notice | **day2**, with a pull request when the notice is in the app's code and the owner says yes. Otherwise the owner copies the drafted section. |
| App Store / Google Play privacy answers | **The owner**, because Apple and Google don't let other tools fill these forms. **Do it with me** on the Privacy page walks through it one screen at a time, with the page to open, then confirms. |
| Connecting Expo, App Store Connect, Google Play (once) | **The owner**, on **Connect your stores**: Sign in with Google (day2 does the Google Cloud side: APIs, service account, Pub/Sub, push, Play invite, reports bucket), one Expo robot token, and the Apple checklist (key, vendor number; with paid products the agreement and the In-App Purchase key). Each step is checked against the app, and a mistake says what to fix. See [connect.md](connect.md). |
| Building and submitting | **day2**, after the connections. The owner approves release notes if they want to. |
| Earning money (purchases, ads, prices) | **day2** plans it, creates products and prices, writes the code through tickets and verifies every purchase. **The owner** approves the plan and price changes, signs Apple's Paid Apps agreement and Google's payments profile, creates the In-App Purchase key, the Pub/Sub push and an AdMob account (each with **Do it with me** on the Money page), and adds the first in-app purchase to an app version in App Store Connect. |
| Live settings and experiments | **day2.** One "Native foundations" release; after that, settings and experiments change over the air. The owner picks **day2 decides** or **Ask me first** on the Live page, and can describe experiments in plain words. |
| Push notifications | **day2** builds them into the app (a ticket), sets up Firebase and the FCM V1 key in EAS after Sign in with Google, and writes, sends and measures the messages. **The owner** approves announcements day2 writes. |

| Store setup (App Store Connect and Google Play forms) | **day2** fills in everything Apple's and Google's APIs allow (links, contact, categories, age rating, App Review details, price and countries, Play details and graphics, previews) and keeps it in sync. **The owner** approves each fact once, enters the App Review demo account, and does the forms with no API (Play's content rating, target audience, ads, app access, declarations, category; both stores' privacy answers) with day2's prepared answers and **Do it with me**, then clicks Done. |
| Store listing, screenshots, tests, reviews | **day2** researches, writes, frames, uploads and replies. The owner approves listing changes, screenshots, tests and replies on the Store page (or picks **day2 decides**), and enters test results from App Store Connect / the Play Console. Google Play experiments: **Do it with me**. |

Still on the owner, not automated yet: the first build of a new app (so EAS has the signing certificates), and the first upload of an Android app in the Play Console. For apps day2 created, the done page lists these with a copy-paste command ([expo-apps.md](expo-apps.md), "Owner steps after Create").

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
| `messages/` | Push tokens, campaigns and send records (Messages) | Postgres. Tokens come back on their own once apps report to production |
| `ad-assets/`, `.day2-fx.json`, `.day2-lovable*.json` | Ad images and videos, exchange-rate cache, Lovable account | Files under `/data` (`DAY2_DATA_DIR`) |
| `.day2-expo-creates.json`, `mockups/` | Native apps being created (plan, drawings, progress) | Postgres (`expo_creates`); drawings under `/data/mockups` |
| `managed-repos/` | App checkouts | `managed-repos/<accountId>/<appId>` on the volume, cloned again through the GitHub App |
| `day2-*.json` / `day2-*.jsonl` **inside each app's checkout** (`day2-backlog.json`, `day2-growth-bets.json`, `day2-autopilot-log.jsonl`, `day2-mobile-releases.json`, `day2-retention.json`…) | Each app's backlog, growth, ads and release state | **Still files** in the app's checkout. Not Postgres |
| `day2-live.json` inside each app's checkout | Live settings, experiments, ideas and their log | Postgres (`live_state`, `live_served`). Not copied: set settings again, and experiments start over |
| `day2-store-listing.json`, `day2-store-reviews.json` inside each app's checkout; `store-screens/` | Store settings, proposals, research, tests, custom pages, reviews and drafted replies; framed screenshots | Postgres (`store_listing`, `store_reviews`); screenshots under `/data`. Not copied: day2 reads the listing and reviews again; approve proposals again |

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
