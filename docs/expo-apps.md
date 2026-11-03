# New native apps with Expo (Create) and assistant actions

Part of the self-improving app design ([self-improving-app.md](self-improving-app.md)). Code: `src/expo-create/`, `src/assistant-actions.ts`. Console: **Apps → Create a new app → Native app for iPhone and Android (Expo)** (`console/src/routes/setup.create.tsx`, `console/src/components/expo-create.tsx`).

## What it does

The owner describes an app. day2 plans it, draws it, builds it as an Expo app, puts it in a private GitHub repo and looks after it from then on, like any app connected to day2.

| Step | Who | What happens |
|---|---|---|
| 1. Describe | Owner | What it does, who it's for, look and feel, iPhone and/or Android, how it makes money (free, subscription, one-time purchase, ads, not sure yet), and optionally the owner's domain. |
| 2. Product plan | day2, then **the owner's OK** | An agent writes the plan: screens (with Expo Router routes), what's stored and where, the first minute of a new user, where money comes in, the 1–3 main actions, open questions. The owner approves or comments; each comment makes a new version. |
| 3. Key screens | day2, then **the owner's OK** | The 2–3 key screens are drawn as phone-sized pictures (the same renderer as ticket mockups, `src/mockups.ts`). Approve or comment; a comment redraws them. |
| 4. Scaffold | day2 | `npx create-expo-app@latest <dir> --template default --yes` — Expo's own tool and default template (Expo Router, TypeScript). `DAY2_EXPO_TEMPLATE` pins a template, e.g. `default@sdk-57`. The plan goes in as `PLAN.md`, the drawings as `design/mockups/*.png`. |
| 5. Prewire | day2 | `app.json`: name, slug, deep link `scheme`, `ios.bundleIdentifier` and `android.package` (see "App IDs"), `runtimeVersion: { policy: "fingerprint" }`, the EAS Update URL when an EAS project exists. `eas.json` as day2's release path wants it (`cli.appVersionSource: remote`, production `autoIncrement` on the `production` channel, Android submit to `internal`). `npx expo install` of `expo-updates`, `expo-application` and every package day2's switched-on modules register as native foundations (`missingNative`, e.g. Live's AsyncStorage) — so the first store build already has them and no separate native foundations release is needed; their wiring instructions go to the polish step. The day2 field library in `day2/` (only when day2 has a public `https://` address). `PRIVACY.md`: a draft notice with day2's section between its markers, so `privacy-notice.ts` keeps it current later. |
| 6. Build | day2 | The build agent (`runBuildAgent`) implements the plan in three steps: **screens**, **data and state**, **polish** (with the field library wired in: `startDay2` with the release tag, `day2.route`, `track("signup"/"activated")`, `day2.action` on the main actions, `identify` on sign-in/out). After each step: `npx tsc --noEmit`, `npm run lint`, and the device checks (`src/device-checks/`) when simulators or EAS are available. A failing step gets one fix attempt with the errors; if it still fails, the owner chooses **Try again** or **Go on anyway**. That is the only other time the owner is asked. |
| 7. Repo | day2 | A private GitHub repo, created and pushed the same way as the Lovable path (`gh repo create --private`, under `DAY2_GITHUB_OWNER` if set). Without a GitHub login on the machine, the app stays a local repository. |
| 8. Onboard | day2 | Registered as a normal day2 app (same app id as during the build). Follow-up tickets in its backlog: release setup (`mobile-release/setup.ts`) when something is still missing (usually the EAS Update URL before the first build), and the assistant actions proposal. The console then goes on to "Check what day2 understood" (the normal onboarding scan). |

Progress is shown live (the console polls the build every 3 seconds: the phase list, the current step, credits used). **Cancel** works at any point: nothing more is built or charged after the step that's running.

### After a restart

Every build is kept (`.day2-expo-creates.json` in day2's data folder locally, the `expo_creates` table in accounts mode, migration `014_expo_create.sql`). When the API starts it carries on with builds that were working (`resumeExpoCreates`), from the start of the phase they were in: uncommitted changes from an interrupted step are thrown away, committed steps stay. Builds waiting on the owner just keep waiting.

### App IDs

The bundle ID (iOS) and package (Android) are the same string, valid on both platforms (lowercase letters, digits and underscores per segment, no Java keywords):

- with a domain: `habitloop.com` + app `habit-loop` → `com.habitloop`; `acme.com` → `com.acme.habitloop`;
- without: from the owner's name, `com.pabloguillen.habitloop`; else `app.day2.habitloop`.

The deep link scheme is the app name without dashes (`habitloop://`).

## Costs

Charged to the account's credits as **App building** (`app_build`, the same service and markup as Lovable builds), and only for agent work that ran. Needs the Growth or Scale plan (`createApps` plan feature) and a free app slot.

| Part | Most day2 pays per run (before markup) |
|---|---|
| Product plan (each version) | $1 |
| Each key screen drawing (up to 3 per round) | $0.60 |
| Each build step (3 steps, at most 2 runs each) | $3 (the build agent's cap) |

The console shows a typical estimate ("≈ N credits") and the worst case before starting; the start is refused when the balance doesn't cover the typical estimate. Device checks on EAS use the owner's Expo build minutes, not credits.

## Owner steps after Create

Shown on the done page with a "Done" box each:

1. **Connect your Expo account** on the app's Releases page (an access token).
2. **Run the first store build once**, with a copy-paste command:
   `cd <app folder> && npx eas-cli@latest init && npx eas-cli@latest build --platform all --profile production`
   (in accounts mode it starts with `gh repo clone <owner/repo>`). `eas init` links the app to the owner's Expo account; the build asks to sign in to Expo and, for iPhone, with the Apple ID, and makes the signing keys.
3. **Create the app in App Store Connect** (iOS) with the bundle ID, and add an App Store Connect API key on Releases.
4. **Create the app in Play Console** (Android) and upload the first build to internal testing by hand once, then add a service account key on Releases.

After that, day2 builds, submits and releases by itself (`docs/mobile-releases.md`).

### First EAS build: why the owner runs it

Checked against Expo's docs in November 2026:

- Expo's CI guide ("Trigger builds from CI") says to run `eas build` once from a terminal for each platform so the credentials are created (Android keystore, iOS distribution certificate and provisioning profile); an App Store Connect API key in CI is described for **repairing** iOS credentials.
- eas-cli 20.2.0 (#3805): non-interactive App Store builds can use the ASC API key stored in EAS to validate, repair **and create provisioning profiles** — distribution certificates aren't mentioned.
- Generating a new Android keystore in `--non-interactive` mode is reported as not supported.

So creating all signing credentials headless from an ASC key is **not verified**, and day2 doesn't attempt it: the owner runs the first build once. If Expo documents it later, the first-build step can become a day2 step with the connected Expo token and ASC key (`src/expo-create/first-build.ts`).

## Assistant actions (Siri, Shortcuts, Android shortcuts)

`src/assistant-actions.ts` proposes making an app's 1–3 most-used actions available:

- **iPhone**: App Intents with App Shortcuts (iOS 16+) — in Siri ("Log a habit in Habit Loop"), the Shortcuts app and Spotlight.
- **Android**: static app shortcuts (long press on the app icon).

Each action opens the app at its **deep link** (`<scheme>://<route>`), so the screens behind them are the app's own; only a thin native layer is new.

**When it's proposed:** only for Expo apps with a deep link scheme in their app config — after Create (from the plan's main actions) and by the growth autopilot's built-in check (`autopilotPass`, step 1a), from field data (screen views and taps that lead to a screen, last 28 days) or, without data, from the app's Expo Router routes. Settings, sign-in, onboarding, `+not-found` and routes with parameters are never actions. Proposed once per app (source key `assistant-actions:v1`; a ticket the owner deleted isn't proposed again).

**The ticket** is a normal build ticket (a feature, so it waits for the owner's OK on the plan like every feature) with exact instructions for the build agent:

1. Each deep link opens its screen (cold start and running), with a Maestro flow per action (`openLink`).
2. An Expo config plugin, `plugins/with-assistant-actions.js`, listed in the app config. No `ios/` or `android/` folders are committed.
3. iOS: the plugin writes `AssistantActions.swift` into the main app target (App Shortcuts must be in the app bundle): one `AppIntent` per action with `openAppWhenRun = true` that opens the deep link, and one `AppShortcutsProvider` whose phrases contain `\(.applicationName)`; everything `@available(iOS 16.0, *)`.
4. Android: `res/xml/shortcuts.xml` with one `VIEW` intent per action to the deep link and `MainActivity`, labels in `strings.xml`, and the `android.app.shortcuts` meta-data on the launcher activity.
5. Unit tests for the generated Swift and XML; `npx expo prebuild --clean --no-install` in a scratch copy must succeed.

**Release:** it's a native change, so it ships with the next store release (Live's native foundations release, registered with `registerNativeNeed` as module `assistant-actions`), never over the air. The fingerprint runtime policy marks it as native by itself.

**Verified by:** the unit tests and prebuild check in the ticket, the Maestro deep link flows on virtual devices, and after the store release by trying the phrase with Siri and long-pressing the icon on Android.

## Settings

| Setting | Default | What |
|---|---|---|
| `DAY2_FEATURE_CREATE_EXPO` | on | `off` hides the Expo option and its API (404). Independent of `DAY2_FEATURE_CREATE_APPS` (Lovable). |
| `DAY2_EXPO_TEMPLATE` | `default` | The create-expo-app template, e.g. `default@sdk-57` to pin an SDK. |
| `DAY2_GITHUB_OWNER` | the gh user | Where new app repos go. |
| `DAY2_DEVICE_CHECKS` | local on a Mac with Xcode | Device checks during the build (`docs/device-checks.md`). |

## API

`/api/expo-create` (GET estimate and builds, POST start), `/api/expo-create/:id` (GET), `…/plan` and `…/mockups` (POST `{ decision: "approve" }` or `{ decision: "comment", comment }`), `…/unstick` (`{ choice: "retry" | "continue" }`), `…/cancel`, `…/owner-steps/:step` (`{ done }`), `…/mockups/:file` (the drawing). Registered from `src/expo-create/routes.ts`.

## Not verified / not built

- **End to end with real agents and a real Expo SDK: not verified.** All tests use fakes for the agents, `create-expo-app`, git, GitHub and device checks. Run one real Create on a Mac before offering it.
- `create-expo-app@latest` picks the SDK it considers current; during an SDK transition that can be the previous SDK (Expo's docs say so for SDK 58). Pin with `DAY2_EXPO_TEMPLATE` if that matters.
- `eas init --non-interactive --force` with the owner's Expo token during prewiring (to get the EAS project id and update URL before the first build): not verified. When it fails, the owner's first-build command runs `eas init`, and the release-setup ticket sets the update URL afterwards.
- Creating all iOS and Android signing credentials without the owner (see "First EAS build"): not verified, so not done.
- Accounts mode: the new repo is created with the server's `gh` login, like the Lovable path. A deployed server has none (it works through the GitHub App), so the app stays a repository on the server until repo creation through the GitHub App is built (needs an org installation with *Administration: write*).
- Accounts mode: the field key needs the app registered first, so day2's field checks are wired in afterwards by the normal "Install day2 field checks" ticket.
- Assistant actions: opening the deep link from an App Intent with `UIApplication.shared.open` after `openAppWhenRun`, and the Android shortcut labels/limits, follow Apple's and Android's documentation but haven't been tried on a device with a day2-built plugin.
- The assistant actions need is registered with Live's native foundations without packages (the plugin is written by its own ticket), so it doesn't open a native foundations ticket by itself; the store release follows from the fingerprint change.
