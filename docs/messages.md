# Messages: push notifications and in-app messages

day2 sends an app's lifecycle messages: a nudge to a new user who tried the app once, a reminder to a regular who stopped coming, a hello to someone who has been gone a long time, and announcements. It writes the texts in the app's voice, sends each push at a good local time, keeps to strict limits, and measures every message against people it was held back from. A message that doesn't bring people back, or makes them turn notifications off, is stopped.

This module builds on [retention.md](retention.md): the same lifecycle states, the same holdouts, the same measurement. Design: [self-improving-app.md](self-improving-app.md), "Messages".

## The parts

| Part | Where | What it does |
|---|---|---|
| Push tokens | `src/messages/tokens.ts`, `016_messages.sql` (`push_tokens`, `message_optouts`) | One Expo push token per device, kept per hashed user, with its time zone and language |
| Store | `src/messages/store.ts` (`app_messages`, `message_sends`) | Settings, campaigns, and one record per planned, held-out or sent message |
| Expo client | `src/messages/expo.ts` | Sends through Expo's push service, reads receipts, retries |
| Timing | `src/messages/timing.ts` | Local time, quiet hours, the user's usual hour |
| Campaigns | `src/messages/campaigns.ts` | Who is in which audience, the limits, holdouts, measurement, the opt-out guardrail |
| Texts | `src/messages/texts.ts` | Writing (agent) and checking (rules plus a second agent) |
| App code | `src/messages/setup.ts` | The native need and the build ticket |
| In-app messages | `src/messages/contributor.ts` | `messages` in Live config |
| Pass | `src/messages/pass.ts`, called by the growth autopilot | Sends, plans, measures |
| API | `src/messages/routes.ts` | `/api/apps/:id/messages/*` |
| Console | **Messages** in the app's navigation | Reach, campaigns, results, announcements, settings |

## What day2 sends, and when

### Campaigns

| Campaign | Who gets it | Default |
|---|---|---|
| New users, the day after | Started yesterday, hasn't been back | day2 decides |
| New users, three days after | Started three days ago, not back in the last two days | day2 decides |
| At risk | The retention state "at risk" | day2 decides |
| Lapsing | The retention state "lapsing" | day2 decides |
| Long gone (win-back) | Dormant, seen in the last 400 days | day2 decides |
| Something happened for you | An event the app reports for someone else, e.g. `friend_joined` with `props.to` = the hashed id of the person to tell | day2 decides |
| Announcement | Everyone with push on, once | Ask me first (when day2 writes it) |

- day2 writes a campaign once people have push on, starting with the stage that loses the most users (the retention snapshot's leak), at most two new campaigns every 6 hours.
- Each user gets a lifecycle campaign at most once per time away. Becoming active again resets it.
- Lapsing and long-gone users are often unreachable by push. When fewer than 40% of recent users have push on, those campaigns also show **in the app** when the person comes back (Live config `messages`, trigger `comeback`).

### Timing and limits

- **Quiet hours:** no push from 21:00 to 09:00 in the user's own time zone. The owner can change it, but it must cover at least 8 hours.
- **The usual hour:** when day2 sees that someone is usually active at a certain hour (3 or more events in that hour over 30 days), their push goes then. Otherwise it goes now, or right after quiet hours. Sends are spread over the first half hour.
- **At most 3 pushes per person per week**, across all campaigns. The owner can set 1 to 7.
- **Stop when ignored** (`mayNudge`, Duolingo's lesson): at most one reminder per period, and none after three unanswered ones since the person was last active. Announcements follow it too. "Something happened for you" messages don't, but they count toward the weekly limit, and the same campaign goes to a person at most once a day.
- **Too late is skipped:** a push that can't go out within 30 hours of its planned time isn't sent.
- **Holdout:** 10% of each campaign's audience never gets it, decided by the hashed id (`arm()` in `lifecycle.ts`), the same everywhere.

### Texts

- An agent writes each campaign in the brand voice (Brand DNA, tone of voice, real features only), in German and English. German is written natively, in the app's own register ("du" when the app says "du").
- Title at most 40 characters, body at most 120, button at most 24.
- **Rule checks:** length; both languages present; the generic-AI patterns from `ai-slop-patterns.ts` in English and German; fake urgency ("last chance", "nur heute"); shaming and pleading ("we miss you"); more than one exclamation mark or emoji; words in capitals; numbers the app's profile doesn't back; the brand's "never say" list.
- **A second agent** that didn't write the texts checks the claims against the app's real features, and checks how they read. An unreadable verdict counts as a fail.
- Texts that fail aren't sent. The campaign shows **Texts need work** with the reasons.
- Each user gets their language: the one the app reported with the token, else German for German-speaking time zones, else English.

## Owner control

On the **Messages** page:

- **Reach:** people with push on (iPhone, Android), and people reachable only in the app.
- **Campaigns:** their texts, when they go out, how many were sent and held out, opens, in-app views, the effect against the holdout, and the opt-out guardrail. Each campaign can be paused, resumed or stopped.
- **Write an announcement:**
  - *I'll write it:* the texts are checked and go out at once. Pressing **Send it** is the owner's OK.
  - *day2 writes it:* by default it waits for **Send it**.
  - An announcement goes out once, at each person's next good local time.
- **Settings:** on/off, quiet hours, pushes per week. Separate autonomy for reminders (default: day2 decides) and for announcements day2 writes (default: ask me first).

Every automatic decision is written to the page's list and the growth autopilot log, with the numbers behind it. Turning the growth autopilot off also stops Messages.

## Measurement

- **Intention to treat, as in retention:**
  - Everyone who entered a campaign counts once, in their arm, whether or not the push reached them.
  - The outcome is being active within the next period of the app's rhythm (the next day, week or month).
- With 30 or more people in each arm, the Bayesian proportion test decides:
  - **brings people back** at 90% or more;
  - **worse** at 10% or less, and day2 stops the campaign;
  - otherwise **no clear change**.
- **Guardrail, turning notifications off:**
  - An opt-out is the app reporting `setPushToken(null)` from a device that had registered a token, or Expo saying the device is gone. A `null` from a device with no token for that user changes nothing and isn't counted.
  - Compared within 7 days after the send, among recipients and among held-out people who also have push.
  - day2 stops the campaign when recipients clearly switch off more (≥ 95% probability and at least 2 points more). Before the holdout is big enough, it also stops at 1 in 10 of 50 or more recipients.
- **In-app messages:** counted from `message_shown`, `message_tapped` and `message_dismissed` events (`props.message` = campaign id, sent by `day2.messageEvent`). **Push opens:** the tap handler calls `day2.messageEvent(campaign, "tapped")` as well as `track("push_opened")`, so opens are counted per campaign for push-only campaigns.
- **In-app holdout:** `audience.percent` (90 by default). Live's library buckets it by its own hash (`msg:<id>`), not by `arm()`, so the people held out in the app aren't the same people held out from the push. In-app messages are therefore judged by their counts, and a campaign's return-rate verdict comes from its push arm.

## How it gets into the app

1. **Native foundations (Live).**
   - Messages registers `expo-notifications`, `expo-device` and `expo-constants`, and the `expo-notifications` config plugin (`registerNativeNeed`).
   - Live's single "Native foundations" ticket installs them with the other modules' needs, in one store release.
2. **The setup ticket** "Push notifications and in-app messages". It's JavaScript only, so after the native release it ships over the air. It's created once the field library reports. The build agent:
   - sets up the notification handler and, on Android, the `default` channel before asking (Android 13 shows no prompt without a channel);
   - **asks for permission after the user's first success, never at launch**, with the app's own short explanation first. On iOS it may use provisional authorization (`allowProvisional`, quiet delivery to Notification Center);
   - gets the Expo push token (`getExpoPushTokenAsync` with the EAS project id) and calls `day2.setPushToken(token)`. It calls `setPushToken(null)` when permission is gone and on sign-out, and listens for token changes;
   - handles taps, both while running and when the tap started the app. It reports `push_opened` and `messageEvent(campaign, "tapped")`, and opens `data.day2.r`, a route in the app, never an external URL;
   - builds one in-app message component in the app's style. It shows `day2.message(trigger)` and reports `day2.messageEvent(id, "shown" | "tapped" | "dismissed")`;
   - writes tests for all of it.
3. Then everything runs on the growth autopilot's timer.

## What the owner sets up

| Platform | Owner does once | Notes |
|---|---|---|
| iOS | Nothing in most cases | EAS creates the push key when it makes the app's credentials during `eas build`. **Not verified** for builds day2 starts non-interactively: if the first build didn't set up push, run `eas credentials` → iOS → Push Notifications once |
| Android | Nothing after **Sign in with Google** on Connect your stores | day2 adds Firebase to the app's Google Cloud project, registers the Android app, gives day2's service account the FCM role and uploads its key to EAS as the FCM V1 key (EAS GraphQL, as `eas credentials` does), once Expo is connected; `google-services.json` comes with a ticket (it may be committed; the key never is). Without day2's Google sign-in: Firebase console → Project settings → Service accounts → generate a key, then expo.dev → Project settings → Credentials → Android → FCM V1 service account key. |
| Expo access token | Already connected on **Releases** | day2 sends it as `Authorization: Bearer …` with every push. That's required when "enhanced push security" is on in the Expo project |

Problems only the owner can fix appear at the top of the Messages page, for example Expo refusing the access token, Google rejecting the FCM key, or a key from a different Firebase project.

## Sending, technically

- `POST https://exp.host/--/api/v2/push/send` takes at most 100 messages per request. Each message carries:
  - `title`, `body`;
  - `data: { day2: { c: campaign id, r: route } }`;
  - `sound: "default"`;
  - on Android, `channelId: "default"`;
  - a `ttl` up to the push's deadline.
- **Receipts:** `POST …/getReceipts`, at most 1,000 ids, read ≥ 15 minutes after sending on the next run. Expo keeps them for 24 hours.
- **Errors:**
  - `DeviceNotRegistered`: the token is invalidated at once and counted as an opt-out.
  - `MessageRateExceeded`: try again in an hour.
  - `MessageTooBig`: can't happen with these lengths. It's recorded.
  - `InvalidCredentials`, `MismatchSenderId`: a fix for the owner.
  - `UNAUTHORIZED`: pushes wait and the owner is told.
  - Network errors, 429 and 5xx are retried with exponential backoff and jitter. 4xx isn't retried.
- **The pass runs every 15 minutes** (the backlog timer):
  - every run: trigger messages from new events, approved announcements, due sends, receipts;
  - every 6 hours: write missing campaigns and plan lifecycle messages from the retention snapshot;
  - daily: measurement, the guardrail, and cleanup.

**Local mode: pushes wait while the Mac sleeps.** day2 sends from the computer it runs on. A push planned for 09:15 goes out when the Mac wakes, if it's still a good local time and within 30 hours. Otherwise it's skipped. In-app messages keep working while the Mac sleeps, because Live config is cached by the inbox Worker.

## Consent and privacy

- **Consent:**
  - Push is opt-in on both platforms: the system asks.
  - day2 sends nothing to someone who said no or turned it off.
  - In the EU, marketing push needs that permission, and the app's privacy notice must say so.
- **Tokens:**
  - Stored only in the token store: Postgres `push_tokens`, or locally `<data>/messages/<app>/push-tokens.json`, readable only by day2's user and never in the app's repo.
  - Kept per hashed user (`u_…`), never with a name or email.
  - **Bound to the device that registered them.** The library sends its device id (the one field batches carry) with every `setPushToken`. A token is stored with that id, and only that device can replace or clear it: a new token from the same device replaces its old one for that user, another device adds its own entry and never touches this one, and `setPushToken(null)` only switches off the sending device's entry. Sending the token itself again counts as being that device (the token is the device's secret). Registrations without a device id are refused, and they're limited to 20 per hashed user and hour (`/api/ingest/<key>/push`, `src/field-ingest.ts`). Tokens registered before this have no device id; the library re-sends its token once with the id after the update, which binds it.
  - **The limit that remains:** the hashed user is `sha256(app key : user id)` and the app key ships in the app. Someone who has the app key and can guess a user id can still register *their own* device for that user, and would then get that user's messages too. They can't remove, replace or switch off the user's real devices. So this only matters when the app's user ids can be guessed: **identify users with an opaque id** (a random account id or UUID from the app's backend), **never an email address, phone number or a counter**.
  - Never in events, logs, the API or the console.
  - Send records hold a short hash of the token (`device`) to match receipts, never the token.
- **Retention periods:**
  - invalid tokens are deleted by the daily cleanup;
  - tokens not seen for 400 days are deleted;
  - send records and opt-outs (hashed ids only) are kept 400 days.
- **Store privacy answers** (`store-privacy.ts`, once the setup ticket is merged):
  - **Apple:** Identifiers → **Device ID**. Apple: "such as the device's advertising identifier, or other device-level ID"; a push token is a device-level ID. Linked to the user, not used for tracking. Purposes: App Functionality, and Developer's Advertising or Marketing ("sending marketing communications directly to your users").
  - **Google Play:** **Device or other IDs**. Google: "identifiers that relate to an individual device, browser or app", e.g. a Firebase installation ID. Collected, not shared, because Expo, Apple and Google deliver on the app's behalf. Purposes: App functionality, Developer communications, Advertising or marketing.
  - The time zone is not treated as location: it is coarser than Apple's "approximate location" (about 3 km²). **Not verified** with Apple or Google.

## What's not verified against real accounts

- Sending to real devices through Expo, with and without enhanced push security. The API calls follow Expo's current documentation, and all network calls in the tests are mocked.
- Whether EAS sets up the iOS push key in builds day2 starts without a prompt.
- Receipts arriving within 15 minutes, and `DeviceNotRegistered` showing up in tickets as well as receipts.
- The library sends `{ user, device, token, platform, tz, locale }` (`PushTokenRecord`). Without a `locale`, day2 guesses the language from the time zone (German-speaking zones → German, else English).
- The store privacy categories, above.
