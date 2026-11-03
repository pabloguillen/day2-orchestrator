# The self-improving app: design

gora8 (day2) builds, maintains and grows React Native / Expo apps. This document is the shared design for the parts that close the gaps to "Amboras for mobile apps":

| Module | What it adds | Code | Doc |
|---|---|---|---|
| **Live** | Remote settings and experiments inside the app, shipped over the air, winners kept automatically | `src/live/`, `packages/sensors/src/live.ts` | `docs/live.md` |
| **Money** | Monetization strategy, subscriptions and in-app purchases (Apple/Google billing, checked by day2), paywalls, in-app ads (AdMob), price tests | `src/money/` | `docs/money.md` |
| **Store** | App Store optimization: listing text, keywords, screenshots, Apple product page tests and custom product pages, ratings prompts and review replies | `src/store-listing/` | `docs/store-listing.md` |
| **Messages** | Push notifications and in-app messages for the lifecycle | `src/messages/` | `docs/messages.md` |
| **Create** | A new native Expo app from a description, with all of the above prewired | `src/expo-create/` | `docs/expo-apps.md` |
| **Assistant actions** | The app's main actions in Siri/Shortcuts and Android app shortcuts | `src/assistant-actions.ts` | in `docs/expo-apps.md` |

## Principles (every module)

1. **Expo first, over the air whenever possible.** Anything that is only JavaScript or configuration reaches users through EAS Update (day2's existing release path: `src/mobile-release/`, 10% → 50% → 100% with crash checks and automatic rollback). Native additions (expo-iap, react-native-google-mobile-ads, expo-notifications, expo-store-review) go into one "native foundations" store release, after which everything else changes over the air.
2. **Configuration over code.** The app's code is written once (by the build agent, in the app's own style), and reads its texts, prices, placements and variants from **Live config**. Experiments change config, not code, so they start and stop without a release.
3. **The app's own UI.** day2 never ships a generic paywall or message UI from the library. The build agent builds each screen once in the app's style; the library gives data and decisions (what to show, to whom, how often).
4. **No new accounts unless unavoidable.** Live config is served by day2 and cached at Cloudflare (the inbox Worker), push goes through Expo (the owner's Expo token is already connected), purchases are checked with the App Store Connect and Google Play access the owner already gave. Unavoidable: an AdMob account (payouts go to the owner), and for subscriptions one extra Apple key (In-App Purchase key) and one Google Pub/Sub topic. Each comes with a "Do it with me" walkthrough and a connection test.
5. **Measured, with a guardrail.** Every change is an experiment with a control or holdout. Each experiment has one primary metric and guardrails: crash rate, and retention when the primary metric is money (ads or a harder paywall must not buy revenue with users).
6. **Owner in control.** Each module has an autonomy setting: *day2 decides* (default for config-only experiments and messages within limits), *ask me first* (default for prices, store listing text and anything that costs users money). Approvals use the existing Approvals page. Every automatic decision is in the activity log with the numbers behind it.
7. **Privacy by design.** No raw user ids, emails, purchase receipts or push tokens in events. Push tokens and purchase records are stored per hashed user (`hashUser`) in their own stores with their own retention. Store privacy answers (`src/store-privacy.ts` `practicesFrom`) learn about every new data practice (ads, purchases, push).
8. **Plain language** in the console and docs, like the rest of day2.

## Shared contracts

### Library (`@day2/sensors/native`, and web where it applies)

New in `startDay2` (native) — all no-ops (return the fallback) when disabled or offline:

```ts
day2.value<T>(key: string, fallback: T): T          // Live config value for this user (experiment variant wins over the default)
useDay2Value<T>(key: string, fallback: T): T         // hook; re-renders when config arrives on first launch only
day2.variant(experimentId: string): string | null    // "control" | variant name | null when not in the experiment
day2.revenue(r: { kind: "subscription" | "purchase" | "ad"; amount: number; currency: string; productId?: string; placement?: string }): void
day2.purchaseToken(): string | null                   // UUID derived from the hashed user, for appAccountToken / obfuscatedAccountId
day2.adPlacement(id: string): { show: boolean; unitId: string | null; format: "banner" | "interstitial" | "rewarded" | "native" | null }
day2.adShown(id: string): void                        // counts toward frequency caps
day2.setPushToken(token: string | null): void         // Expo push token (stored by day2 per hashed user, never in events)
day2.message(trigger: string): Day2Message | null      // in-app message to show now for this trigger, honoring caps
day2.messageEvent(id: string, what: "shown" | "tapped" | "dismissed"): void
day2.shouldAskForReview(): boolean                    // the moment to call expo-store-review's requestReview()
```

- **Config loading:** `GET {endpoint}/api/ingest/{key}/config?p=ios|android&r={release}` → `LiveConfig`. Kept in `storage` (`day2.live`). On launch the cached config is used at once; a fresh one is fetched in the background and **takes effect on the next launch** (values never flip during a session), except on the very first launch, where the first fetch (≤ 1.5 s) is waited for by `useDay2Value`. Refetched on foreground at most every 15 minutes.
- **Assignment unit:** the hashed user (`identify`) when known, else the device id when `identity: "device"`, else none → the user gets defaults and is not part of experiments (sessions are not a stable unit, and storing an id needs consent in the EU). Assignment is `assignVariant(unit, experiment)` (`src/experiments.ts`, ported into the library), so the server can recompute it.
- **Exposure:** the first `value()`/`variant()` read of an experiment's key in a session sends an `exposure` event with `props: { exp, variant }`. Only exposed units are counted (intention to treat from the first exposure).
- **Batches carry assignments:** `Batch.variants: Record<experimentId, variant>` for experiments the unit is exposed to.

### Events (`packages/sensors/src/types.ts`, `src/field-ingest.ts` `cleanBatch`, `src/field-store.ts`)

`GrowthEvent` gains two optional fields, cleaned strictly at ingest:

- `props?: Record<string, string | number | boolean>` — ≤ 8 keys, keys `^[a-z][a-z0-9_]{0,31}$`, strings ≤ 80 chars.
- `value?: { amount: number; currency: string }` — amount ≥ 0 and < 10 000, ISO 4217 currency.

`Batch.variants` is cleaned (≤ 20 entries) and stored on each event of the batch as `EventLike.variants` (the field already exists in `src/metrics/types.ts`). Postgres: migration `012_live.sql` adds `props jsonb`, `value jsonb`, `variants jsonb` to `field_events`, plus the Live tables.

Event types used across modules: `exposure`, `revenue` (from the device: `value`, `props.kind`, `props.product`/`props.placement`), `purchase_verified` (server, from store notifications), `refund`, `ad_shown`, `paywall_shown`, `message_shown`/`message_tapped`, `push_opened`, `review_prompt`.

### Live config (served to apps)

```ts
type LiveConfig = {
  v: 1;
  version: number;                 // increases on every change
  values: Record<string, Json>;    // defaults (flags, texts, paywall and ad settings, messages)
  experiments: Array<{
    id: string;                    // "X-3"
    keys: string[];                // config keys it overrides
    variants: Array<{ name: string; weight: number; values: Record<string, Json> }>; // includes "control"
    audience?: Audience;
  }>;
  ads?: Record<string, { format: "banner" | "interstitial" | "rewarded" | "native"; unitId: { ios?: string; android?: string }; cap: { perSession?: number; perDay?: number; minSecondsBetween?: number }; audience?: Audience; enabled: boolean }>;
  messages?: Array<{ id: string; trigger: string; title: string; body: string; cta?: { label: string; route?: string; url?: string }; cap: { total: number; perDay: number }; audience?: Audience; locale?: Record<string, { title: string; body: string; cta?: string }> }>;
  review?: { afterEvents: Record<string, number>; minDaysSinceInstall: number; minDaysBetween: number; notAfterProblem: boolean };
};
type Audience = { platforms?: ("ios" | "android")[]; locales?: string[]; newWithinDays?: number; fromAds?: boolean; minRelease?: string; percent?: number };
```

- Built by `src/live/config.ts` from the app's Live store; contains nothing secret (it's public to anyone with the app's key, like contracts).
- Served by `handleIngest` (`/api/ingest/:key/config`, GET, `cache-control: public, max-age=60`, `etag` = version).
- **At the edge:** the inbox Worker (`deploy/inbox/worker.js`) passes the GET through and keeps the last good body per key in D1 (`live_config` table); when day2 can't be reached it answers with the kept copy. So apps get config while the Mac sleeps.

### Extension points (to keep modules independent)

- **Config contributors** — `src/live/contributors.ts` exports a list of `LiveContributor = { module: string; contribute(app: AppEntry, ctx): Promise<Partial<Pick<LiveConfig, "values" | "ads" | "messages" | "review">>> }`. `src/live/config.ts` merges Live's own values and experiments with every contributor's part. Money adds paywall values and `ads`, Messages adds `messages`, Store adds `review`. Each module adds one line to the list.
- **Native foundations** — `src/live/native-foundations.ts` exports `registerNativeNeed({ module, packages: string[], plugins?: unknown[], instructions: string, whenNeeded(app): Promise<boolean> })`. Live's pass gathers the needs of all modules that are switched on and, when anything native is missing from the app, opens **one** ticket ("Native foundations for …") that installs them together, so they reach users in a single store release. Live's own needs: `expo-updates`, `@react-native-async-storage/async-storage` (for `storage` + `identity: "device"` only after consent), `expo-application`.
- **Ingest sub-routes** — `handleIngest` dispatches `/api/ingest/:key/<sub>` through a small table (`config`, `contracts`, `push`). `push` (POST `{ user, device, token, platform, tz, locale }`; `device` = the library's field-batch device id, required; `token: null` = push turned off on that device) calls an injected `IngestDeps.pushTokens.save(appId, { user, device, token, platform, tz, locale, at })` (`PushTokenRecord` in `src/field-ingest.ts`) that Messages implements and wires in `src/api-server.ts` next to `liveConfig`; until then it answers 204 and stores nothing. Tokens are bound to `device`: only that device can replace or clear its entry, another device only adds its own (docs/messages.md). Registrations are limited per hashed user. Rate limits come in this order: per address (`cf-connecting-ip`, else X-Forwarded-For with `DAY2_TRUST_PROXY=on`), then the key is looked up, then per key — unknown keys never get a bucket, and buckets over their limit are never evicted.
- **Revenue in metrics** — events with `value` feed `src/metrics/monetization-kpis.ts` (`computeRevenuePerUser`, `revenuePerUserByVariant`; `REVENUE_EVENT_SIGN`: `revenue` +, `refund` −), so Live can judge money experiments without depending on Money. `purchase_verified` is not summed (it would count a device-reported purchase twice); Money either sends verified purchases as `revenue` or adds its type to `REVENUE_EVENT_SIGN` and stops the device-side event.
- **Contributor context** — `contribute(app, { now, live })` (`live`: Live's own state, read-only). Every app gets the same config, so a contribution must not depend on who asks (the version would churn); audiences decide on the device.
- **Store notifications at the edge** — the Worker answers the stores `200`, keeps the body (not the Authorization header) and day2 replays it to its path in-process (`drainInbox` marks the Request object, `replayOf` in `src/ingest-inbox.ts`; an `x-day2-inbox` header from outside means nothing); a 404 (no handler yet) keeps it waiting. Unverified Google replays are queued under their own ids (`google:inbox:…`), at most 200 wait at once, and a change is only recorded when the Play API's subscription state agrees. The CSRF check in `handleRequest` skips `/api/store-notify/`; Money registers the routes with `{ public: true }`.

### Server stores and passes

- One store per module behind an interface with a file version (local mode, `day2-<module>.json` in the app's state dir via `appFile`) and a Postgres version (accounts mode), like `field-store.ts`.
- Passes hang off the growth autopilot (`src/growth-autopilot.ts`, like `retentionPass`) on the backlog timer; each pass is idempotent and cheap when nothing changed.
- Agent work (research, writing, building) goes through `runWithCredits` with the existing credit services (`agent_work`, `content_generation`, `app_build`), and builds code only through **backlog tickets** (the build agent, device checks, pull requests), never by editing the repo outside a ticket.
- Public webhook paths for store notifications: `/api/store-notify/apple/:appId` and `/api/store-notify/google/:appId`. They are added to the tunnel allowlist (`deploy/tunnel/day2-tunnel.sh`) and buffered by the inbox Worker like reports.

### API and console

- Routes under `/api/apps/:id/live/*`, `/api/apps/:id/money/*`, `/api/apps/:id/store/*`, `/api/apps/:id/messages/*`, registered from each module's `routes.ts` with one line in `src/api-server.ts`.
- Console pages: **Live** (`apps.$appId.live.tsx`), **Money** (`apps.$appId.money.tsx`), **Store** (`apps.$appId.store.tsx`), **Messages** (`apps.$appId.messages.tsx`), linked from the app shell's navigation; queries in `src/lib/queries.ts`; e2e mocks in `e2e/mock-api.mjs`.

## Owner steps per module (and what day2 does instead)

| Module | Owner does once | day2 does |
|---|---|---|
| Live | Nothing beyond field checks (`identify` on sign-in) | The "native foundations" ticket; config; experiments; decisions |
| Money | Sign the Paid Apps agreement (Apple) and set up a payments profile (Google); create the In-App Purchase key and the Pub/Sub topic (walkthroughs); create an AdMob account and app | Strategy, products and prices via the store APIs, paywall and ad code, server notifications, verification, price and placement tests |
| Store | Approve listing changes (default) | Research, texts, screenshots, uploads, product page tests, custom product pages for ads, review replies |
| Messages | Android: upload the FCM V1 service account key in EAS once (iOS push key: EAS); approve announcements day2 writes | Permission prompt timing, token handling, campaigns, in-app messages |
| Create | Describe the app; first EAS build if Apple credentials can't be made from the API key | Plan, mockups, the Expo app, repo, checks, setup of all modules |
