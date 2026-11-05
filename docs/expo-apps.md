# New native apps with Expo (Create) and assistant actions

Part of the self-improving app design ([self-improving-app.md](self-improving-app.md)). Code: `src/expo-create/`, `src/assistant-actions.ts`. Console: **Apps → Create a new app → Native app for iPhone and Android (Expo)** (`console/src/routes/setup.create.tsx`, `console/src/components/expo-create.tsx`).

## What it does

The owner describes an app. day2 writes the list of every screen, draws all of them in one design system, and shows them as a flow map and a clickable prototype. Only when the owner has approved the whole flow does day2 build it as an Expo app — screens one to one with the drawings, with the backend they need — put it in a private GitHub repo and look after it from then on, like any app connected to day2.

| Step | Who | What happens |
|---|---|---|
| 1. Describe | Owner | What it does, who it's for, look and feel, iPhone and/or Android, how it makes money (free, subscription, one-time purchase, ads, not sure yet), and optionally the owner's domain. |
| 2. Screen list | day2 | An agent writes the plan with its **screen inventory** (`plan.ts`): every screen with its name, Expo Router route, purpose, main elements, states (empty, loading, error, filled) and **where each button goes** (`links: [{ label: "Tap Start", to: "sign-up" }]`), grouped into flows — first launch, sign in (only with accounts), main loop, settings and profile, paywall (only when the app earns money from users), and the empty and error states as their own screens (`stateOf`). Also: what's stored and where, server functions, the first minute, money, the 1–3 main actions, the app's language, whether users share data (`sharedData`), live updates (`realtime`) and where most users are (`countries`). From that, **whether the app needs a hosted backend** (see "Hosting"). At most 16 screens. |
| 3. Design system | day2 | Before any screen: colors (10 fixed roles), fonts (system stacks only), type styles, spacing, corners, components and voice, derived from the look and feel (`design.ts`). Drawn as its own **style card** (`style-vN.png`). |
| 4. Every screen | day2 | Each screen as a high-fidelity iPhone mockup (390×844, status bar, safe areas), Android (412×915) only for screens marked `androidDiffers`. The drawing may only use the design system's tokens — day2 puts them in front of every drawing as CSS variables — with realistic content in the app's language. Tappable elements carry `data-goto="<screen id>"`; the renderer reads their boxes as the prototype's **hotspots**. Rendered with Playwright (`mockups.ts renderScreen`), PNG plus the HTML. Resumable screen by screen. |
| 5. Flow map | day2 | One overview of all screens as thumbnails in one lane per flow, connected by arrows labelled with the action ("Tap Start → Sign up"). A layered layout written for it (`flow-map.ts`): columns are taps from the first screen, back links go round below. Rendered to `map-vN.png`; the console draws the same layout. |
| 6. Review | **The owner** | In the console: the flow map, a **clickable prototype** (hotspots from the links; links without a hotspot are listed under the phone), the style card and the screen list. The owner pins comments on a screen or writes text per screen (or on the style card, or on everything), adds or removes screens, and asks for changes. A round redraws **only the affected screens** — commented ones, new ones, ones whose plan entry changed, everything not approved when the style card was commented — and the map, as a new version (v1, v2…) with a **before/after view**. Single screens can be **approved early**: they never change in later rounds (the agent's revised list is overridden for them). Next to it, the plan's **backend decision**: needed or not and why, the region the data would live in, and the expected hosting cost a month in credits. Then the owner **approves the whole flow** (every screen must be drawn). |
| 7. Scaffold | day2 | `npx create-expo-app@latest <dir> --template default --yes` — Expo's own tool and default template (Expo Router, TypeScript). `DAY2_EXPO_TEMPLATE` pins a template, e.g. `default@sdk-57`. In the repo: `PLAN.md`, `design/screens/<id>.png` and `.html` (`.android.*` where drawn), `design/style.png`, `design/design-system.json`, `design/flow.json` (screens, links, hotspots), `design/flow-map.png`, and `.maestro/day2/screens.yaml` (opens every screen with its own route by deep link and takes a screenshot `screen-<id>`). |
| 8. Prewire | day2 | `app.json`: name, slug, deep link `scheme`, `ios.bundleIdentifier` and `android.package` (see "App IDs"), `runtimeVersion: { policy: "fingerprint" }`, the EAS Update URL when an EAS project exists. `eas.json` as day2's release path wants it (`cli.appVersionSource: remote`, production `autoIncrement` on the `production` channel, Android submit to `internal`). `npx expo install` of `expo-updates`, `expo-application` and every package day2's switched-on modules register as native foundations (`missingNative`, e.g. Live's AsyncStorage) — so the first store build already has them and no separate native foundations release is needed; their wiring instructions go to the polish step. The day2 field library in `day2/` (only when day2 has a public `https://` address). `PRIVACY.md`: a draft notice with day2's section between its markers, so `privacy-notice.ts` keeps it current later. |
| 9. Build | day2 | The build agent (`runBuildAgent`) implements the approved flow in four steps (`build-steps.ts`): **(a) design system as code** — day2 writes `src/theme/tokens.ts` from the design system, the agent adds dark mode, `useTheme()` and every component in `src/components/ui/`; **(b) screens and navigation** exactly as drawn and linked, with sample data; **(c) data and backend** behind the backend adapter (see "Hosting"): data model, auth if the plan has accounts, storage, server functions — on day2's Supabase when the app is hosted; **(d) polish** and day2's wiring (field library: `startDay2` with the release tag, `day2.route`, `track("signup"/"activated")`, `day2.action` on the main actions, `identify` on sign-in/out; the privacy screen; Live's native packages). After each step: `npx tsc --noEmit`, `npm run lint`, and the device checks (`src/device-checks/`) when simulators or EAS are available. A failing step gets one fix attempt with the errors; if it still fails, the owner chooses **Try again** or **Go on anyway**. |
| 10. Built vs. drawn | day2 | When a device check took screenshots (`screen-<id>` from day2's Maestro flow), each is put next to its approved drawing; the console shows them side by side per step. After steps (b)–(d) the agent fixes **clear mismatches once** per step (`visualFixReport`; the screenshots are copied to the git-ignored `design/compare/`), then the checks run again. |
| 11. Repo | day2 | A private GitHub repo, created and pushed the same way as the Lovable path (`gh repo create --private`, under `DAY2_GITHUB_OWNER` if set). Without a GitHub login on the machine, the app stays a local repository. |
| 12. Onboard | day2 | Registered as a normal day2 app (same app id as during the build). Follow-up tickets in its backlog: release setup (`mobile-release/setup.ts`) when something is still missing (usually the EAS Update URL before the first build), and the assistant actions proposal. The console then goes on to "Check what day2 understood" (the normal onboarding scan). |

The owner is asked only at the review (step 6) and when a build step stays stuck. Progress is shown live (the console polls the build every 3 seconds: the phase list, the current step — "Drawing Today (3 of 9)" — and credits used). **Cancel** works at any point: nothing more is drawn, built or charged after the step that's running.

### States

`plan → style → design → flow_review ⇄ flow_revise → design → … → scaffold → prewire → theme → screens → backend → polish → publish → onboard → done` (`types.ts PHASES`). The screen flow is kept on the build (`flow`): `versions` (each with its plan, design system, style card, drawings — an unchanged screen keeps the drawing of the version that made it — map, what changed and what was asked), `draft` (the version being drawn), `comments` (per screen, optionally pinned, with the version that took them into account), `approved` (screens approved early) and `pending` (the change request being worked on). Drawings, style cards and maps are files in `<data>/mockups/<app id>/flow/`, not in the record.

**Older builds** (stored before the screen flow) are moved when read (`migrate.ts`, record format `v: 2`): `plan` → `plan`; `plan_review` (waiting) → `flow_review` with a v1 of the plan's screens, none drawn — the owner asks day2 to draw them (nothing is charged without that click); `mockups` → `style`; `mockup_review` (waiting) → `flow_review` with the key screens' drawings; `screens` → `theme`; `data` → `backend`; the rest stay. A stuck step's phase moves the same way. The record is JSON in the same table, so no SQL migration is needed.

### After a restart

Every build is kept (`.day2-expo-creates.json` in day2's data folder locally, the `expo_creates` table in accounts mode, migration `014_expo_create.sql`). When the API starts it carries on with builds that were working (`resumeExpoCreates`), from the start of the phase they were in: screens already drawn in the version being drawn stay drawn, uncommitted changes from an interrupted build step are thrown away, committed steps stay. Builds waiting on the owner just keep waiting.

### App IDs

The bundle ID (iOS) and package (Android) are the same string, valid on both platforms (lowercase letters, digits and underscores per segment, no Java keywords):

- with a domain: `habitloop.com` + app `habit-loop` → `com.habitloop`; `acme.com` → `com.acme.habitloop`;
- without: from the owner's name, `com.pabloguillen.habitloop`; else `app.day2.habitloop`.

The deep link scheme is the app name without dashes (`habitloop://`).

## Hosting (the app's backend)

Code: `src/expo-create/hosting.ts` (Create's side), `src/hosting/index.ts` (Hosting's, [hosting.md](hosting.md)).

### Does the app need one? (the plan)

The plan needs a hosted backend when it has **accounts**, **data shared between users** or synced between devices (data stored "on a server"), **file uploads** (server data with photo/file fields), **server functions**, or **live updates** (`hostingReasons` in `plan.ts`). Otherwise everything stays on the phone. The decision is shown at the flow approval and in `PLAN.md` ("## Backend"): why, the region (from the plan's `countries` and language, `regionFor` — e.g. Germany → Frankfurt), and the expected cost a month as credits (`monthlyEstimate`: the project's compute at Supabase's price, service "Hosting"). The console's Create form shows that monthly line separately; it is never part of the build estimate or the build's credits.

### The backend step, hosted

When the plan needs hosting and the operator set up Supabase (`SUPABASE_ACCESS_TOKEN`, `DAY2_SUPABASE_ORG_ID`; not with `DAY2_FEATURE_HOSTING=off`):

1. **Prewire** already installed the native packages the hosted backend needs (expo-secure-store, AsyncStorage, Apple/Google sign-in as planned: `hostingNativePackages`), so the first store build has them.
2. **Setup**: `ensureHosting(app, hostingPlanFrom(plan))` — the production project in day2's organization, sign-in (redirects for the app's scheme), buckets for uploads, eas.json — then `applyMigrations(app, "staging")` creates the staging project. Hosting's hosted-backend ticket (`hostedBackendTicket`) becomes part of the build agent's brief.
3. **The build agent** writes `supabase/migrations/*.sql` (a table per server type, row level security and policies on every table), edge functions in `supabase/functions/` for the plan's server functions, and `src/backend/hosted.ts` with supabase-js against the adapter interface: typed client, the sign-in session kept encrypted on the device (expo-secure-store + AsyncStorage), storage, realtime where needed. `src/backend/index.ts` (written by day2) picks hosted when `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY` are set, and the in-memory `local.ts` in tests (`NODE_ENV=test`) and without them.
4. **Staging first**: day2 checks the migrations against Hosting's rules (RLS on every table, expand before contract — `migrationProblems`), applies them to staging, deploys the functions there, writes `.env` with staging's public values and eas.json with production's (store builds) and staging's (other profiles). The step's checks — type check, lint, **device checks against staging** — run after that. A rule broken or a migration failing on staging fails the step like a failing check (one fix attempt, then the owner's call).
5. **Production** after the checks pass: `applyMigrations(app, "production")` (Hosting's release rules: checked on staging, so they apply), the functions, and the hosted-backend ticket is marked done. If production refuses something, the first release applies it (`beforeRelease`).

Builds are resumable here too: after a restart the backend step runs again from its start, and Hosting carries on from the last setup step it finished (each step is remembered; a project created just before a crash is adopted, not created twice).

If the setup stops (Supabase errors, a project that doesn't come up), the build doesn't stop: the app keeps its local backend, the done page says so, and Hosting finishes the setup on its own timer once the app is registered (its hosted-backend ticket then connects the app).

### Not configured

When Supabase isn't set up on the server, Create keeps the in-memory backend (`local.ts`, persisted on the device) and says so in plain words — at the approval ("needed, not set up here yet"), in the backend step's ticket (no provider SDK), and on the done page: **Next: host the backend with day2**, with a link to the app's Hosting page. A parked backlog ticket ("Host the backend with day2") keeps it in view. Once the operator has set up Supabase, the owner presses **Host with day2** on the Hosting page and day2 writes the ticket that connects the app.

### The done page

Shows where the backend is (region, project, expected credits a month) and links to the app's Hosting page (`/apps/<id>/hosting`).

## Costs

Charged to the account's credits as **App building** (`app_build`, the same service and markup as Lovable builds), and only for agent work that ran. Needs the Growth or Scale plan (`createApps` plan feature) and a free app slot.

| Part | Most day2 pays per run (before markup) |
|---|---|
| Screen list (each version that changes it) | $1 |
| Design system (v1, and each version where the style card was commented on) | $0.60 |
| Each screen's drawing (Android drawings count separately) | $0.60 |
| Each build step (4 steps, at most 2 runs each, plus one run to match the drawings) | $3 (the build agent's cap) |

The console shows a typical estimate ("≈ N credits": the first version with about 10 screens, one round of changes redrawing about 3 screens, and the four steps) and the worst case before starting; the start is refused when the balance doesn't cover the typical estimate. Each round of changes is checked against the balance before it starts (`estimateRound`). Device checks on EAS use the owner's Expo build minutes, not credits.

## The backend adapter

Before the backend step day2 writes `src/backend/` into the app (`backend-adapter.ts`): `types.ts` (the plan's data model), `adapter.ts` (one typed `Backend` interface: a `Collection<T>` per data type with list/get/create/update/remove/subscribe, `auth` when the plan has accounts, `functions` for the plan's server functions), `local.ts` (an in-memory implementation, optionally persisted on the device, e.g. with AsyncStorage — so the app runs, its tests run, and it works without a server), `hosted.ts` (supabase-js against day2's Supabase project when the app is hosted — the build agent writes it; otherwise a TODO) and `index.ts` (the switch by env). The screens only ever talk to `backend`, so hosting an app later changes `hosted.ts` and nothing else.

## Claude Design and other design tools

Claude Design (claude.ai's design canvas) has no Anthropic API; it is reachable only through Claude Code's `/design` command with a claude.ai account. Create doesn't depend on it.

- **Download for Claude Design / Figma** (console, on the review): `GET /api/expo-create/:id/flow/export.zip?v=N` — a zip (`export.ts`, written without a dependency by `src/zip.ts`) with every screen as a standalone HTML page and a PNG, the style card, the flow map (`index.html`, linked to a script-free clickable `prototype.html`), `flow.json` and `design-system.json`, and a README on importing. Nothing is sent anywhere; changes made in those tools come back only as the owner's comments.
- **Not built, not verified:** a local-mode integration that drives Claude Code's `/design` with the owner's own subscription (e.g. day2 handing the zip to `/design` and reading the result back). It looks possible on the owner's Mac, but nothing about it has been tried.

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

`/api/expo-create` (GET estimate and builds, POST start), `/api/expo-create/:id` (GET; each version comes with its flow map `layout`). The review: `…/flow/comments` (POST `{ screenId, text, pin?: { x, y } }`, `screenId` may be `style` or `flow`; DELETE `…/flow/comments/:commentId`), `…/flow/screens/:screenId` (POST `{ approved }`), `…/flow/changes` (POST `{ note?, add?: [{ name, purpose }], remove?: [ids] }`), `…/flow/approve`, `…/flow/files/:file` (a drawing, style card or map; HTML with a sandboxing CSP), `…/flow/export.zip?v=N`. Building: `…/shots/:key?f=` (a simulator screenshot next to its drawing), `…/unstick` (`{ choice: "retry" | "continue" }`), `…/cancel`, `…/owner-steps/:step` (`{ done }`), `…/mockups/:file` (old key-screen drawings). Registered from `src/expo-create/routes.ts`.

## Not verified / not built

- **End to end with real agents and a real Expo SDK: not verified.** All tests use fakes for the agents, `create-expo-app`, git, GitHub and device checks (the Playwright rendering of a screen and its hotspots is tested with real Chromium where it's installed). Run one real Create on a Mac before offering it.
- How well a drawing agent keeps to the tokens and marks every link with `data-goto` across 10–16 screens: not measured. Links without a hotspot still work in the prototype (listed under the phone).
- The simulator screenshots per screen rely on day2's Maestro flow opening each route by deep link; screens that need a signed-in user or data show whatever the app shows then. Pairing them with the drawings has only run with fake device reports.
- The generated backend adapter type-checks on its own (tested with the TypeScript compiler); inside a real Expo project with the build agent's changes it hasn't been tried.
- **Hosting from Create: tested with fakes only** (Hosting's in-memory Supabase, fake agents). Not tried against a real Supabase organization: a build agent writing working migrations, RLS policies and a supabase-js `hosted.ts` in one step; the device checks picking up `.env` (Expo loads it for development builds); and the time a new project takes to come up during a build (Create waits up to four rounds of Hosting's 15-minute wait).
- The monthly hosting estimate is the production project's compute (Micro) at Supabase's list price; usage beyond the included amounts, the staging project's compute while it isn't paused, and preview databases come on top.
- `create-expo-app@latest` picks the SDK it considers current; during an SDK transition that can be the previous SDK (Expo's docs say so for SDK 58). Pin with `DAY2_EXPO_TEMPLATE` if that matters.
- `eas init --non-interactive --force` with the owner's Expo token during prewiring (to get the EAS project id and update URL before the first build): not verified. When it fails, the owner's first-build command runs `eas init`, and the release-setup ticket sets the update URL afterwards.
- Creating all iOS and Android signing credentials without the owner (see "First EAS build"): not verified, so not done.
- Accounts mode: the new repo is created with the server's `gh` login, like the Lovable path. A deployed server has none (it works through the GitHub App), so the app stays a repository on the server until repo creation through the GitHub App is built (needs an org installation with *Administration: write*).
- Accounts mode: the field key needs the app registered first, so day2's field checks are wired in afterwards by the normal "Install day2 field checks" ticket.
- Assistant actions: opening the deep link from an App Intent with `UIApplication.shared.open` after `openAppWhenRun`, and the Android shortcut labels/limits, follow Apple's and Android's documentation but haven't been tried on a device with a day2-built plugin.
- The assistant actions need is registered with Live's native foundations without packages (the plugin is written by its own ticket), so it doesn't open a native foundations ticket by itself; the store release follows from the fingerprint change.
