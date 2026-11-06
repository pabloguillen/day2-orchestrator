# Connect your stores

One page per app — **Connect your stores** in the console (`/apps/<app>/connect`) — with every store connection day2 needs, where each stands (connected / needs you / checking / broken, with why), what it unlocks (Releases, Store, Numbers, Money, Messages, Ads) and the one thing to do next. Home shows a card while steps are left, and Releases, Money, Messages and Store point here instead of asking for keys themselves.

Code: `src/connect/` (orchestrator), `src/routes/apps.$appId.connect.tsx` and `src/components/connect-hub.tsx` (console).

Every key goes where the feature that uses it already keeps it, encrypted with `DAY2_SECRETS_KEY` and never returned by the API: the Play service account, App Store Connect key and Expo token in `release_credentials`; the In-App Purchase key and Pub/Sub identity in `money_credentials`; vendor number and reports bucket in the Numbers settings. The old endpoints (`PUT /api/apps/:id/mobile-releases/accounts/:kind`, `PUT /api/apps/:id/money/connections/:kind`, `PUT /api/apps/:id/numbers/settings`) keep working.

## What the owner does

| Store | Clicks | What day2 does |
|---|---|---|
| **Google Play** | **Sign in with Google** → tick the boxes → pick a project (or "create one") and paste the Play Console address → **Set it all up**. Then, if Google didn't let day2 invite itself: one invite in Play Console (exact email, deep link and the permission names on the page) → **Check**. About 4 clicks + 1 paste, or ~9 with the manual invite. | Turns on Android Publisher, Play Developer Reporting, Pub/Sub, Firebase and FCM; creates the service account `day2-<app>` and a JSON key (stored as the Play service account); gives it the FCM role, adds Firebase and the Android app, opens a ticket that adds `google-services.json`; uploads the key to EAS as the FCM V1 key (when Expo is connected — else one click later); creates the Pub/Sub topic and push subscription to `/api/store-notify/google/<app>` and lets Google Play publish to it (only when Money plans paid products); invites the service account in Play Console with the users + grants API; finds the reports bucket (`pubsite_prod_rev_<id>`, checked with the owner's token). |
| **Expo** | Open **Robot users** (link) → Create robot user "day2", role **Developer** → Create access token → paste → **Connect**. 4 clicks + 1 paste. | Checks the token (GraphQL `meActor`), finds the EAS project (`extra.eas.projectId`, else `@owner/slug` in the robot's accounts), or creates it on **Find or create it**; opens a ticket that writes the project id into `app.json` when it isn't there. |
| **Apple** | Integrations (link) → + → name, **App Manager** → Generate → Download → drop the `.p8` here (Key ID is read from `AuthKey_<ID>.p8`) → paste Issuer ID → **Add the key**. Then paste the vendor number. ~8 clicks + 2 pastes. With paid products also: confirm the Paid Apps agreement, the In-App Purchase key the same way, **Set it for me** for the notification URL. Once, for App Analytics: an Admin key dropped once (not kept). | Checks the key against the app's bundle id; sets the App Store Server Notifications URL (production and sandbox, V2) through the App Store Connect API; checks the vendor number with a sales report; starts the App Analytics reports (needs Admin once). |
| **Meta (ads)** | On Ads: **Connect** next to Meta → Facebook → pick the Page (and Instagram account). | The picked Page is also the app's ads Page (what Platform → Facebook Pages for ads stores). Manual id entry stays as fallback. |

Steps only appear when they apply: Apple only with an iOS bundle id, Google only with an Android package, the In-App Purchase key / Paid Apps agreement / notifications / Pub/Sub only when the Money plan has paid products, Meta only when Meta ads can run.

## What stays with the owner, and why

- **Apple Developer Program, agreements, keys.** Apple has no API to enroll, accept the Paid Apps agreement or create App Store Connect / In-App Purchase keys, and apps publish under the customer's own account (guideline 4.2.6). day2 checks each key the moment it's added and marks the membership active when App Store Connect answers.
- **Apple vendor number.** No API returns it; the owner pastes it once (checked with Apple right away).
- **App Analytics.** Apple lets only an Admin key create the report request. The owner drops a one-time Admin key; day2 uses it for that one call and doesn't store it.
- **Play Console invite** — only when the owner isn't allowed to manage users there or skipped the Play Console address: Google's users API needs the owner to have the right in Play Console. The guided step lists the email, the permissions and a **Check** button (opens and discards a Play edit with the service account).
- **Play Console RTDN topic.** The Play Developer API has no call to set the Real-time developer notifications topic; the page shows the topic name to paste in Monetization setup.
- **Expo robot token.** Expo has no OAuth for other services ([programmatic access](https://docs.expo.dev/accounts/programmatic-access/)): one paste.
- **First build / first Play upload** (unchanged, see expo-apps.md).

## What day2 keeps from Google

Google's consent uses `access_type=online`: **no refresh token**. The access token (one hour) is kept encrypted (`connect_google_sessions`, or `.day2-connect-google-sessions.json` locally), sealed together with the sign-in's PKCE verifier, between the consent page and the end of setup. It's revoked at Google and deleted:

- when setup finishes (successfully or not);
- when the sign-in fails or is cancelled (Google's error, a failed code exchange, projects that can't be listed, **Cancel** on the project picker);
- at the latest an hour after the sign-in started, by the backlog timer (`purgeGoogleSessions`) — for a tab closed halfway.

The callback is protected by PKCE (S256; the verifier never leaves day2) and a single-use `state`: the first callback consumes it, a replay is refused. If a session's token is ever replaced, the old one is revoked. Ongoing work uses the service account day2 created. Running setup again needs a new sign-in.

## Error texts

Google, Apple and Expo errors can quote what was sent. Every note and problem stored in `day2-connect.json` or shown on the page passes `scrub()` (`connect/state.ts`): PEM blocks, `private_key` / `private_key_id` / token values, Google access tokens and long opaque strings are removed (on top of `ads/http`'s `redact()`), and the file is scrubbed again on every write. Uploading the FCM key to EAS never stores Expo's own text at all — only a fixed message and Expo's error code.

## Play Console permissions

The service account is invited with the least each feature needs (`playPermissions()` in `connect/google-cloud.ts`); the money ones only when the Money plan has paid products. The guided step lists the same set.

| Play Console permission | API enum | Needed for |
|---|---|---|
| View app information and download bulk reports (read-only) — account-wide, the only level Play offers it | `CAN_VIEW_NON_FINANCIAL_DATA_GLOBAL` | Numbers: installs reports bucket, Android vitals |
| Release to production, exclude devices, and use Play App Signing | `CAN_MANAGE_PUBLIC_APKS` | Releases: staged rollouts, halting |
| Release apps to testing tracks | `CAN_MANAGE_TRACK_APKS` | Releases: EAS Submit to internal testing |
| Manage store presence | `CAN_MANAGE_PUBLIC_LISTING` | Store: listing, graphics, store setup |
| Reply to reviews | `CAN_REPLY_TO_REVIEWS` | Store: review replies |
| Manage orders and subscriptions — paid products only | `CAN_MANAGE_ORDERS` | Money: reading and acknowledging purchases, refunds |
| View financial data, orders, and cancellation survey responses — paid products only | `CAN_VIEW_FINANCIAL_DATA` | Money: voided purchases (refunds, chargebacks) |

Whether vitals need "View app quality information" on top isn't verified yet; if the Reporting API refuses, Numbers says so.

## day2's files in the app's folder

`day2-connect.json` sits next to the app's code like day2's other state files (`day2-backlog.json`, `day2-money.json`, `day2-*.jsonl`…). None of them may reach the customer's repo: day2 adds `/day2-*.json`, `/day2-*.jsonl` and `/day2-*.tmp` to the checkout's own `.git/info/exclude` (never committed, the customer's `.gitignore` is untouched) when the app is added, on every backlog pass and on every save here, and every `git add -A` day2 runs for a commit excludes them by pathspec (`src/day2-state-files.ts`).

## Operator setup

- **Google OAuth client** (Web application) in day2's Google Cloud project: `DAY2_GOOGLE_OAUTH_CLIENT_ID`, `DAY2_GOOGLE_OAUTH_CLIENT_SECRET`. Without them day2 reuses the sign-in client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) — then that client needs the extra redirect URI and scopes. Without either, the page offers pasting a service account key.
- **Redirect URI:** `https://<domain>/api/ads/connect/callback/googlecloud`. It's under the ads callback pattern, so the tunnel allowlist (`PUBLIC_PATH_SOURCE`, `deploy/tunnel`) already covers it locally; register the tunnel host's URI too when testing locally.
- **Scopes on the consent screen:** `openid`, `email`, `https://www.googleapis.com/auth/cloud-platform`, `https://www.googleapis.com/auth/androidpublisher`. Both API scopes are **sensitive**: until Google verifies the consent screen only listed test users can sign in (with an "unverified app" warning). Verification can take weeks — start it early ([go-live-checklist.md](go-live-checklist.md)).
- **Platform → Connect your stores** shows which client is used, the missing env names, the redirect URI and the scopes.
- **Meta:** day2's own Meta connection now also asks for `pages_show_list`, so Platform → Facebook Pages for ads can pick each app's Page from a list (reconnect Meta once).

## API

See the header of `src/connect/routes.ts`. `DELETE /api/apps/:id/connect/google/session/:sid` cancels a sign-in (revoked and deleted). All routes are scoped to the signed-in account (`requireApp`) and need an owner/admin for changes; the Google session must belong to the same account and app; `/api/platform/connect` is operator-only.

## Not verified against real accounts

Built from the providers' docs and tested with recorded responses only (`src/connect/connect.test.ts`):

- Google: PKCE with Google's Web client flow (supported per Google's docs, with the client secret too), and Resource Manager `projects.create` for accounts without an organization, Service Usage `batchEnable` for these six APIs, IAM key creation (blocked by `iam.disableServiceAccountKeyCreation`, which new Google Cloud organizations enforce by default — the page says what to change), Firebase `addFirebase` / `androidApps.create` / `getConfig`, the Play `users.create` + `grants.create` calls for a **service account** email and with a human user's OAuth token, whether `pubsite_prod_rev_<developer id>` is really the reports bucket name (it often isn't; then the owner pastes it once), and how long Play takes to apply the invite.
- Expo: the GraphQL queries and mutations are eas-cli's own (not a documented public API): `meActor` with a robot token, `app.createApp` with the Developer role (may need Admin), `createGoogleServiceAccountKey` + `setGoogleServiceAccountKeyForFcmV1` / `createAndroidAppCredentials`.
- Apple: `PATCH /v1/apps/{id}` with `subscriptionStatusUrl…` attributes (listed in the App Store Connect API's AppUpdateRequest), and the sales-report error codes for a wrong vendor number.
- Meta: `pages_show_list` on the ad-account connection needs App Review like the other scopes.

First real check: one test app (Dotty) — sign in with Google on a fresh Google account, then on one inside an organization; connect Expo with a Developer robot; add an App Manager key; send a test purchase notification from each store.
