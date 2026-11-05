# Hosting: the app's backend, run by day2

Part of the self-improving app design ([self-improving-app.md](self-improving-app.md)). Code: `src/hosting/`. Console: **App → Hosting** (`console/src/routes/apps.$appId.hosting.tsx`). API: `/api/apps/:id/hosting/*`.

## What day2 hosts

Like Lovable for websites, day2 runs the backend of the apps it builds. Each app gets **one Supabase project** in **day2's own Supabase organization**, with:

| Part | What the app gets |
|---|---|
| Database | Postgres, with row level security (RLS) on every table — the app reads and writes only what its rules allow |
| Sign-in | Email (a 6-digit code), Sign in with Apple, Sign in with Google |
| Files | Storage buckets; people write only into their own folder |
| Live updates | Supabase Realtime, where the app needs it |
| Server functions | Edge functions from `supabase/functions/` in the app's repo, with their secrets |

The app only knows two public values: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY` (the **publishable** key — public by design; RLS protects the data). The secret key and the database password stay with day2, encrypted, and never go into the app or the console.

## Where the data lives

In one region, picked from the app's audience: German-speaking and most EU countries → Frankfurt (`eu-central-1`), France/Spain → Paris, Nordics → Stockholm, UK → London, US → North Virginia, and so on (`src/hosting/region.ts`). The owner can pick another region before setup. The data stays in that region; moving it later means moving the data.

The app's privacy answers (App Store, Google Play) and its privacy notice name Supabase and the place: the store answers gain "Contact Info → Email Address" (sign-in) and "User Content" (files), linked to the user, for App Functionality only — Supabase is a processor, so nothing counts as shared or tracking. The notice section says where the data is stored, that Supabase works as day2's subprocessor under a DPA (Art. 28 GDPR), and, outside the EU, that transfers rely on the Standard Contractual Clauses. After a takeover it says Supabase is the owner's own processor.

## Costs

Before an app is created, Create shows the expected cost a month (`monthlyEstimate` in `operations.ts`: the production project's compute — Micro — at Supabase's price, as credits) as its own line, separate from the build's credits.

The owner sees **credits only** (service "Hosting", `infra`, with day2's usual markup). Once a day day2 charges the day before, per app:

- **Compute** — the project's compute size at Supabase's price (from the project's billing add-ons; Micro otherwise).
- **Database size** beyond the 8 GB included per project.
- **Files**, **data sent** (egress, from the logs), **server function calls**, and **preview databases** (per hour) at Supabase's list prices.

Supabase list prices used (November 2026 — **check current prices** on supabase.com/pricing before relying on them; they're in `RATES`, `src/hosting/operations.ts`): Pro plan $25/month per organization with $10 compute credits; compute Micro $10/month, Small $15, Medium $60 (billed hourly); database $0.125/GB beyond 8 GB; egress $0.09/GB beyond 250 GB; storage $0.0213/GB beyond 100 GB; 100,000 monthly active users included; edge functions $2 per million beyond 2 million; branching $0.01344 per branch per hour; point-in-time recovery $100/month per 7 days. The organization's own fee and its included quotas are day2's overhead, not split per app.

If credits run out, day2 opens a ticket and **keeps the backend running** — it never pauses a live app by itself. Pausing is the owner's call on the Hosting page.

## How it's set up

**New apps (Create)**: the plan decides whether the app needs a backend (accounts, data shared between users or devices, uploads, server functions, live updates) and shows it at the flow approval with the region and the expected credits a month (`monthlyEstimate`). Create's backend step then calls `ensureHosting` with `hostingPlanFrom(plan)` and makes a staging project; the build agent writes the migrations (RLS on every table), edge functions and `src/backend/hosted.ts` with supabase-js; day2 applies the migrations to staging, runs the device checks against staging, then applies them to production through `applyMigrations` — see [expo-apps.md](expo-apps.md), "Hosting". When Supabase isn't set up on the server, the app keeps its backend on the phone and gets a "Host with day2" follow-up.

**Other apps** without a backend: the owner presses **Host with day2**. day2 then, step by step (each step is remembered, so a restart picks up where it stopped):

1. **Creates the project** (Management API `POST /v1/projects`): name, region, a generated database password (stored encrypted), compute size (Micro).
2. **Waits until it's healthy** (project status and the health endpoint).
3. **Gets the keys**: the publishable key for the app; the secret key kept encrypted on day2 only.
4. **Sets up sign-in**: site URL and redirect URLs for the app's deep link scheme (`habitloop://**`; staging also `exp://**`), email templates in the app's language (English, German), Apple and Google once the owner added their details, and the email sender.
5. **Creates the storage buckets** with their policies (SQL through the Management API).
6. **Applies the migrations** in `supabase/migrations/` (below).
7. **Deploys the edge functions** in `supabase/functions/` and lists the secrets they still need.
8. **Runs Supabase's security and performance advisors.** Findings become backlog tickets; a table without RLS is a P1 security ticket.
9. **Points the app at it**: eas.json `env` in every build profile (written in the repo for a new app, otherwise as a small ticket), and EAS environment variables (`eas env:set`, production and preview) so over-the-air updates get the same values.
10. **Asks the build agent** (a backlog ticket; during Create its text is the backend step's brief and the ticket is done when the step passes) to implement the hosted side of the app's backend adapter (`src/backend/`, written by Create): supabase-js with the session kept encrypted on the device (expo-secure-store + AsyncStorage), typed queries from the generated types (Management API types endpoint), storage uploads, realtime where needed, sign-in with Apple/Google natively. The ticket repeats the rules: RLS policies per table in migrations, no service key in the app, expand before contract.

### Sign-in with Apple and Google (the owner's accounts)

Guided on the Hosting page, with a **connection test** before anything is saved:

- **Apple**: Team ID, Key ID and the .p8 key of a "Sign in with Apple" key; a Services ID for Android/web sign-in. day2 makes Apple's client secret (a JWT, valid 6 months) and makes a new one a month before it runs out. The test asks Apple's token endpoint with a made-up code: `invalid_grant` means the details are right.
- **Google**: a Web OAuth client (ID and secret) plus the iOS and Android client IDs. Same test against Google's token endpoint.

### Email

Supabase's built-in sender only reaches members of day2's Supabase organization, at 2 emails an hour — fine for testing, useless for users. day2 uses its own sender (`DAY2_HOSTING_SMTP_URL`) for every app, or the owner's own SMTP server (Hosting page → Email sender). Without either, the page warns that email sign-in only reaches the team.

## Environments and database changes

- **Production**: one project per app.
- **Pull requests**: when day2's organization has Supabase branching (paid plans), each pull request that changes `supabase/` gets its own **preview database** (`POST /v1/projects/{ref}/branches`), removed when the PR closes. Without branching, one shared **staging** project per app; it pauses after a week unused and wakes for the next PR.
- **Releases**: production migrations are applied **just before** the over-the-air update or store build that needs them (`beforeShip` in `src/mobile-release/pass.ts`), and only after they passed on a preview or staging (day2 makes a "release check" preview when they haven't).

Rules day2 enforces on production (and the tickets explain):

- Every table in `public` has RLS turned on in the migrations.
- **Expand first, contract later.** People keep old app versions for weeks, so a migration that drops or renames a table or column, changes a type or makes a column required without a default must be marked `-- day2:contract` and ship only after the app versions that used the old shape are gone. Unmarked ones are held back with a ticket.

Migrations are applied through the Management API's SQL endpoint, each file in one transaction together with its row in `supabase_migrations.schema_migrations` — the same history the Supabase CLI keeps, so `supabase db push` and day2 agree. When the SQL endpoint isn't answering, day2 falls back to `supabase db push --db-url` (CLI 2.122.1). Edge functions deploy through the Management API's deploy endpoint, with `supabase functions deploy --use-api` as the fallback.

## Keeping it healthy

On the backlog timer (`hostingAll`, after the other passes):

- **Every hour**: status, database size, connections, requests, data sent and edge function errors. Alerts (tickets) at 80% of the included database size, 85% of the disk, 80% of the connections, or more than 5% failing function calls.
- **Every day**: the credits for the day before, the backups, the advisors, and Apple's client secret if it's due.

## Backups

Supabase backs up paid projects every day and keeps them 7 days (Pro). Point-in-time recovery is an add-on (extra credits); the Hosting page says whether it's on. Restoring is done by the operator on request (Supabase dashboard or `POST /v1/projects/{ref}/database/backups/restore`), not by a button yet.

## How to leave: your own Supabase organization

**Move to my own Supabase organization** on the Hosting page:

1. The owner makes an access token in their Supabase account and gives their organization's slug.
2. day2 makes a **claim token** for the project with its own token; the owner's token previews the move (warnings such as the target plan) — Supabase's project-claim endpoints.
3. The owner confirms; the owner's token claims the project. Nothing about the app changes: same address, same key, same data.
4. From then on Supabase bills the owner's organization, day2 stops charging hosting credits, and **day2 keeps looking after the project with the owner's token** (stored encrypted).

If Supabase refuses the claim token, the page shows the guided way: the owner invites day2's operator to their organization for the move, the operator uses Supabase's dashboard (Project settings → General → Transfer project), and the owner pastes their token (**It's moved — use my token**).

## Apps that already have a backend

No automatic migration. **Host with day2** is offered only to apps day2 created (Create's `src/backend/` adapter) and Expo apps without a backend. An app that already talks to its own servers, Firebase, its own Supabase project, Amplify, Appwrite, Convex and the like (`src/hosting/eligibility.ts`) keeps its backend; moving live data and accounts is a project for the owner, not something day2 does in passing.

## Operator setup (once)

1. **Create day2's Supabase organization** at supabase.com (e.g. "day2 apps") and put it on the **Pro plan** or higher — Free projects pause after a week without use and have no backups or branching. Turn on spend caps as you prefer; compute for each project is billed hourly on top of the plan.
2. **Make an access token**: as a member (Owner) of that organization, supabase.com → Account → Access tokens. A dedicated "day2 robot" account is better than a person's.
3. **In `deploy/.env`**: `SUPABASE_ACCESS_TOKEN=sbp_…`, `DAY2_SUPABASE_ORG_ID=<slug>` (from supabase.com/dashboard/org/<slug>).
4. **An email sender for apps**: `DAY2_HOSTING_SMTP_URL=smtp://user:pass@host:587` and `DAY2_HOSTING_SMTP_FROM=no-reply@…` (Resend, Postmark, SES…; a domain with SPF/DKIM).
5. **Connection test**: `bun run src/hosting/operator.ts` — prints the organization, its plan and whether branching is available, plus warnings.
6. Optional: `DAY2_HOSTING_DEFAULT_REGION` (eu-central-1), `DAY2_HOSTING_INSTANCE_SIZE` (micro), `DAY2_FEATURE_HOSTING=off` to hide hosting.

Legal: Supabase is a **subprocessor** of day2 for hosted apps. Sign Supabase's DPA (offered in the organization's settings in the dashboard) and list Supabase, with the regions in use, in day2's own subprocessor list and data processing terms.

## Settings

| Setting | Default | What |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | — | day2's Management API token (hosting is off without it) |
| `DAY2_SUPABASE_ORG_ID` | — | day2's organization slug |
| `DAY2_HOSTING_SMTP_URL`, `DAY2_HOSTING_SMTP_FROM` | — | day2's email sender for apps' sign-in emails |
| `DAY2_HOSTING_DEFAULT_REGION` | `eu-central-1` | When the audience says nothing |
| `DAY2_HOSTING_INSTANCE_SIZE` | `micro` | Compute for new projects |
| `DAY2_FEATURE_HOSTING` | on | `off` hides hosting |

Storage: `app_hosting` (state, nothing secret) and `hosting_secrets` (encrypted) — migration `021_hosting.sql`; locally `<data>/hosting/<app>/`.

## API

`GET /api/apps/:id/hosting` (the page), `POST …/hosting` (Host with day2), `…/retry`, `…/check`, `PUT …/sign-in/apple|google`, `DELETE …/sign-in/:provider`, `PUT …/email`, `POST …/secrets`, `…/migrations` (staging), `…/pause`, `…/resume`, `…/takeover/preview|confirm|adopt`. Registered from `src/hosting/routes.ts`. Never returns a secret, a cost in money or the markup.

## What's verified and what isn't

Checked against Supabase's published Management API OpenAPI spec (November 2026): every endpoint day2 calls, the create-project body (`organization_slug`, `region_selection`, `desired_instance_size`), the auth config fields, API keys (`reveal=true`, publishable/secret types), branches, advisors, types, backups, billing add-ons, claim tokens. eas-cli 27.2.0's `env:set` flags were checked in its source.

**Not verified** (everything is tested with fakes; nothing has run against a real Supabase organization):

- **Create → Hosting end to end**: tested with the in-memory Supabase and fake agents only (needed / not needed / not configured, staging before production, a restart halfway through setup).
- **End to end against a real organization.** Create one hosted test app (Dotty) before offering it: project, keys, sign-in with a real email, one migration, one function, one advisor finding, eas.json, a store build that signs in.
- The SQL endpoint (`database/query`, beta) running `BEGIN … COMMIT` with the history row; a migration that contains its own transaction statements would break this.
- Edge function deploy through the Management API's multipart endpoint with the file layout day2 sends (`<name>/index.ts`, `_shared/…`).
- The log SQL for function errors and data sent (Supabase's log tables and fields); the numbers stay empty if the query fails.
- Whether an API-created branch (without the GitHub integration) starts with the production schema; day2 applies all migrations the branch doesn't have, either way. The entitlement key for branching isn't documented (day2 looks for any key with "branch", else assumes paid plans have it).
- **Pausing a paid-plan project through the API**: Supabase's dashboard offers pausing only on the Free plan. If the pause is refused, staging keeps running and its compute is charged.
- The claim-token move between organizations (previewed and claimed with the owner's token); the guided dashboard transfer is the fallback.
- The CLI fallbacks (`supabase db push --db-url`, `supabase functions deploy --use-api`) and the pooler URL day2 builds for them.
- Apple/Google connection tests through the token endpoints (the `invalid_grant` vs `invalid_client` answers are how both document errors; not tried with real accounts).
- Credits per day are estimates from Supabase's list prices and the day's snapshot, not Supabase's invoice.
