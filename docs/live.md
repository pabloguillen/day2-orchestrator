# Live: settings and experiments in the app, over the air

Live lets day2 change an app's settings and run experiments without a new App Store or Google Play release. The app's code is written once to read a setting ("the welcome title", "trial days"). After that, day2 changes the value, or gives different users different values, and keeps what works.

This is the shared base for the other modules (Money, Messages, Store). They put their settings into the same config and use the same events. See [self-improving-app.md](self-improving-app.md) for the overall design.

## The parts

| Part | Where | What it does |
|---|---|---|
| Library | `packages/sensors/src/live.ts`, wired into `native.ts` (and `web.ts` for value, variant, revenue) | Reads the config, picks each user's variant, sends exposures, revenue, ad and message counts, push tokens, the review moment |
| Events | `GrowthEvent.props`, `.value`, `Batch.variants`; `cleanBatch` in `src/field-ingest.ts`; `src/field-store.ts`; `012_live.sql` | Small facts and money on events, and which experiments a device was in |
| Revenue metrics | `src/metrics/monetization-kpis.ts` | Revenue per user, by variant, from `revenue` and `refund` events |
| Store | `src/live/store.ts` | One document per app: `day2-live.json` locally, `live_state` in Postgres |
| Config | `src/live/config.ts`, `src/live/contributors.ts` | Builds what apps get: Live's values and experiments plus every module's part |
| Experiments | `src/live/experiments.ts` | Shape checks, build and cleanup tickets, measuring, guardrails, decisions |
| Ideas | `src/live/ideas.ts` | An agent proposes experiments from the app's code, profile, brand, numbers and biggest retention leak; it also writes up the owner's own words |
| Native foundations | `src/live/native-foundations.ts` | One ticket for all native packages the modules need |
| Pass | `src/live/pass.ts`, called by the growth autopilot | Moves each experiment one step; starts the next one when there's room |
| Ingest | `GET /api/ingest/<key>/config`, `POST /api/ingest/<key>/push` | What apps call |
| Edge | `deploy/inbox/worker.js` | Keeps the last good config per app and serves it while day2 is away |
| API | `/api/apps/:id/live/*` (`src/live/routes.ts`) | The Live page |
| Console | **Live** in the app's menu | Experiments and their results, ideas, "describe an experiment", settings, who decides |

## How it reaches an app

1. **Native foundations.** Live needs `expo-updates`, `@react-native-async-storage/async-storage` and `expo-application` in the app. If any are missing, day2 opens one ticket, "Native foundations for …", together with what the other modules need (for example `expo-iap`). They reach users in one store release. After that, everything else changes over the air.
2. **The library.** The field-checks library is already in the app (`src/day2/native.js`). Each Live ticket places the newest copy, the same way retention tickets do.
3. **Reading a setting.** In a component: `const title = useDay2Value("onboarding.title", "Welcome")`. Elsewhere: `day2.value("paywall.trial_days", 7)`. The fallback is what the app does today.
4. **Config.** On launch the app uses the config it saved last time. It asks day2 for a fresh one in the background: `GET {endpoint}/api/ingest/{key}/config?p=ios&r=1.4.0(23)`. The fresh one takes effect **on the next launch**, so values never change while someone uses the app.
   - **First launch:** nothing is saved yet. `useDay2Value` waits for the first answer, at most 1.5 seconds. If day2 is slower, the app goes on with its fallbacks.
   - **Foreground:** when the app comes back to the foreground, it asks again, at most every 15 minutes.
   - **Caching:** day2 answers with `cache-control: public, max-age=60` and an `etag` (the config's version). An unchanged config answers `304 Not Modified`.
5. **While day2 sleeps.** The inbox Worker at Cloudflare passes the request on, and keeps the last good answer per app key. When day2 can't be reached, it answers with that copy (header `x-day2-kept: 1`).

## Who is in an experiment

- **The unit is the signed-in user** (`day2.identify`, hashed).
- **Otherwise the device**, if the app keeps a device id (`identity: "device"`, only after consent where required).
- **Otherwise nobody.** The user gets the defaults and isn't counted. Sessions aren't stable enough to test with.
- **Assignment:** `assignVariant(unit, experiment)`, the same function on the device and on day2's server (`src/experiments.ts`). It is deterministic: the same unit always gets the same variant.
- **Audiences** limit an experiment, ad or message to platforms, languages, new users, users from ads, a minimum app version, or a share of users. The device and day2 share the same code (`src/live/audience.ts`).
- **Exposure:** the first time a session reads an experiment's setting, the library sends an `exposure` event (`props: { exp, variant }`). From then on, every batch carries `variants`. Only exposed users count, from their first exposure ("intention to treat"). Devices on an old version never read the new setting, so they are never counted.

## An experiment's life

| State | What happens |
|---|---|
| Not started (`draft`) | Written down by you, or by day2 from your description. You check it and press Start. |
| Waiting for your OK (`to_approve`) | day2 proposed it and you chose **Ask me first**. |
| Being built (`building`) | The app doesn't read a setting yet. A backlog ticket asks the build agent to read it, with today's behaviour as the fallback. The ticket follows the backlog's own rules. |
| Waiting for the update (`waiting`) | The ticket is merged. day2 waits for the release that contains it: an over-the-air update from day2's releases (its update id), or devices reporting it. It starts when the first users see it. |
| Running | Measured on every pass. |
| Decided | Better, worse, or no clear change, with numbers. |
| Kept (`promoted`) | The winner's values become everyone's default and the experiment leaves the config. If code was written for it, a cleanup ticket removes what only the losing versions used. |
| Stopped | Everyone gets control. |

Experiments that only change settings the app already reads skip "being built" and "waiting": they start at once.

### Measuring and deciding

- **One goal per experiment:**
  - the share who do an event (for example `dot_added`);
  - the share who come back after a week (D7: active on day 7 after their first exposure);
  - revenue per user.
- **Proportions** (events, D7) use a Bayesian Beta-binomial comparison (`evaluateProportionExperiment`).
- **Revenue per user** uses a Bayesian bootstrap. Most users pay nothing and a few pay a lot, so a plain average comparison would mislead.
- **Deterministic:** both are seeded per experiment, so the same data gives the same numbers.
- **Minimum sample:** 200 users per version by default. Before that, day2 never calls a winner.
- **Maximum duration:** 28 days. After that, with no clear answer, control stays ("no clear change").
- **Winner:** a version that is at least 95% likely better. "Worse": every version at most 5% likely better.
- **Guardrails** are checked as soon as each version has 50 users. A breach stops the experiment at once:
  - **Crash rate:** a version is 95% likely to crash more, by at least 1 point.
  - **D7 retention, for money goals:** a version is 95% likely to keep fewer users. More revenue isn't worth losing users.
- **Every decision is logged with its numbers:** on the Live page ("What day2 did") and in the growth autopilot's log.

### Who decides

- **day2 decides** (default):
  - day2 starts experiments from its own ideas;
  - it keeps winners of experiments that only change settings.
  - Experiments that needed code wait for you to press **Keep**, because a cleanup ticket follows.
- **Ask me first:** day2's experiments wait for your OK before they start, and you pick what to keep.

### Ideas

- **When:** every 14 days, when there's room (at most 2 experiments at once by default), and on **Think of new ideas**.
- **What the agent sees:** the app's profile, brand DNA, screens and a few files, the settings the code already reads, the last 30 days of events and revenue, and the biggest retention leak.
- **What it proposes:** settings-only experiments first. No dark patterns.
- **Describe an experiment** turns your words into versions and a goal, as a draft you check and start.
- **Cost:** each run is paid from credits (`agent_work`, at most $1 of model use).

## Settings for other modules (library side)

The library already has what Money, Messages and Store need. They only add their part to the config through `src/live/contributors.ts`.

| Call | What it does |
|---|---|
| `day2.revenue({ kind, amount, currency, productId?, placement? })` | A `revenue` event with `value` and `props.kind` / `product` / `placement`. Checked: 0 ≤ amount < 10 000, a three-letter currency. |
| `day2.purchaseToken()` | A UUID (v4 shape) from the hashed user and the app key, for Apple's `appAccountToken` and Google's `obfuscatedAccountId`. day2 can compute it from the hashed user. Null before `identify`. |
| `day2.adPlacement(id)` / `day2.adShown(id)` | Whether to show an ad now: on, audience, at most per session and per day, seconds between. Counted on the device. |
| `day2.setPushToken(token)` | Sent to `POST /api/ingest/<key>/push` with the hashed user, platform and time zone. It waits for `identify` and isn't sent again when unchanged. It is never in events. Until Messages stores tokens, day2 accepts and drops them. |
| `day2.message(trigger)` / `day2.messageEvent(id, what)` | The in-app message for a moment, in the user's language when given, with total and daily limits. `shown`, `tapped` and `dismissed` become events. |
| `day2.shouldAskForReview()` | True when the events in `review.afterEvents` happened often enough, the app was installed long enough ago, the last ask was long enough ago, and (with `notAfterProblem`) nothing crashed or broke this session. Remembers the ask. |

- **Where counters live:** the app's `storage` (AsyncStorage) when given, else memory for that launch.
- **Bundle size:** the React Native bundle grew by about 9 KB minified. It has no new dependencies.

## Privacy

- **The config holds no secrets.** Anyone with the app's key can read it, like the contracts. It contains settings, experiment shapes, ad unit ids and message texts. It never holds user data.
- **Events stay small:**
  - props: at most 8 keys of short names, strings of at most 80 characters;
  - money: amount and currency only;
  - `variants`: at most 20 experiment ids.
  - Anything else is dropped at ingest.
- **No raw identifiers:** no user ids, emails, push tokens or receipts in events. Users are hashed with the app's key. Push tokens go to their own endpoint and store.
- **Keeping a device id needs consent:** it is used only when the app sets `identity: "device"`, which it may do only after consent where the law requires it. Without it, users who aren't signed in get defaults and aren't tested on.
- **Store notifications:** `/api/store-notify/apple|google/<app>` is public on the tunnel and kept by the Worker like reports. The Authorization header is not kept. A replayed notification has to prove itself (Apple's signed payload, or a lookup with Google). day2 marks replays in-process when it drains the inbox; no header can make a request from outside count as one.

## What's not verified

- **On a phone:** not run on a real device or simulator yet. Tested with a fake React Native, fake storage and a fake day2. That covers caching, the first-launch wait, assignment, exposure, caps, push and review.
- **The Worker** is tested with a fake D1, not deployed. Run `deploy/inbox/setup.sh` again to add the `live_config` table and the `store-notify` route.
- **The release path:** "waiting for the update" uses day2's own mobile-releases file and the release tags devices report. It hasn't been run against a real EAS update.
- **Statistics:** checked on synthetic data only. The thresholds are reasonable defaults, not tuned:
  - 95% to decide or stop;
  - 200 users per version;
  - 28 days at most;
  - 1 point more crashes.
- **Ideas:** the agent's prompt and parser are tested. The ideas themselves haven't been judged on a real app.
- **Approvals:** "Ask me first" shows its approvals on the Live page, not on the Approvals page (which lists pull requests).
