# Creative quality: posts, slides and ads that look like the app

The first real post day2 made for Dotty looked like an ad template: a small
phone with English App Store screenshots on a grey gradient, a German
headline on top, crossfades, a placeholder "D" on the end card. This is
the pipeline that replaced it:

```
the app's repo ──► brand kit ─┐
real screens (de) ────────────┼─► art director ─► template render ─► design critique ─┐
idea (social writer) ─────────┘   (shot list)     (video + slides)   (≤ 2 re-renders) │
                                                                                      ▼
                         owner: Use this one / Approve / edit slide words ◄── 1–2 variants
                                       │
                                       └─► taste learning (per template) ─► next art director run
```

Code: `src/creative/` — `brand-kit.ts`, `capture.ts`, `art-director.ts`,
`templates/`, `motion/`, `render.ts`, `critique.ts`, `taste/`, `studio.ts`,
`runtime.ts`, `edit.ts`, `figma.ts`, `studio-routes.ts`. Console: post cards
on **Growth → Posts**, brand kit and template gallery on **Growth → Formats**.

Samples for Dotty (mock captures, see below): `bun run src/creative/samples-cli.ts
<dotty repo> <out dir>` renders every template (MP4, slides, contact sheets,
the extracted kit and a layout report).

## 1. Brand kit — the app's own design language

`extractBrandKit(repoPath)` reads the app's checkout (no app code runs):

| What | From |
|---|---|
| Colours | named hex tokens in theme-like files (`theme/`, `tokens`, `colors`, `tailwind.config.*`, CSS variables), every hex in StyleSheets (weighted lower), `app.json` (adaptive icon background, `primaryColor`, splash, notification colour) |
| Roles | brand colour = the saturated colour closest to the icon's background/average colour (what people recognise); ink = the darkest text-like colour; background, surface, a second accent |
| Fonts | font files the app bundles (`expo-font` plugin list first), weights from file names; display = heaviest (≥ 800), body = 600/500/400 |
| Radii, shapes | `radius` token object or common `borderRadius` values; pill buttons; soft/strong shadows; 3D buttons |
| Icon, logo | `app.json` → `icon` (never a placeholder letter: no icon → name only) |
| Illustration | the app's 3D icon set (`assets/3d`, `icons3d`) → used as stickers in posts |
| Copy | UI strings from screens/components → language (`guessLanguage`), casual "du" vs "Sie", emoji, slang, sample lines |

Layers, last wins: extracted → Brand DNA's confirmed primary → Figma styles
(when connected) → owner edits (Growth → Formats → Edit). Stored next to the
app's other day2 files as `day2-brand-kit.json`; **Read again** re-extracts
and keeps the owner's edits. Dotty: `#f5d84a` (from its icon), ink `#222222`,
Nunito Black/SemiBold embedded from its font files, radius 18, 26 3D
stickers, German, "casual (du), uses emoji, playful, current slang".

## 2. Actual screens, in the audience's language

`capture.ts`. Capture plan per app: the 3–6 moments from
`.maestro/day2/store-screens.json` (or `.maestro/day2/social-moments.yaml`
when the app has a dedicated flow, which may also record clips), else the
app profile's features. On the owner's Mac: `simctlCommands` sets
`AppleLanguages`/`AppleLocale` to the audience's locale (Dotty: de-DE),
overrides the status bar (9:41, full battery), then the Maestro flow runs
with `DAY2_LOCALE`, `DAY2_DEMO=1` (the demo data the device checks use) and
`simctl io screenshot` / `recordVideo`. Captures are cached per locale and
**stale on a new app version** (or after 30 days). EAS cloud runs that
produce screenshots feed the same cache.

Fallback order (`chooseScreens`): fresh captures in the language → the
owner's **uploaded screenshots** for that language → older captures (from
before the latest version) → the store screenshot pipeline's raw captures
for that locale → App Store screenshots with a **"Screens are in English"**
warning on the post card (and the critique counts it) → web screenshots.
Screens can't be re-rendered in another language (they're pictures), so
day2 never silently mixes.

Clean frames: the status bar is cropped off in cards, screens are shown
large and bleeding off the edge (no device frame), and every template
zooms to / lifts off the region that matters.

## 2b. Real screens: demo cast, seed plan, flow, capture with a temporary database, upload

Until this, `captureMoments` was never called, Dotty had no Maestro flow
and no demo data — posts fell back to English App Store screenshots. The
pipeline now — run by day2 itself, see "The automatic pipeline" below; the
owner only steps in when a step needs attention:

```
profile + brand kit + language ─► demo cast (JSON, checked) ─► owner approves
                                   + pictures (image tool / bundled / placeholder)
app's supabase/migrations ─► schema ─► seed plan (data, checked, cached by migrations hash)
build agent ticket ─► .maestro/day2/store-screens.yaml (+ .json, demo sign-in, day2-demo profile) as a PR
capture run:  temporary database (Docker: supabase start, a copy of the migrations)
              ─► seed (auth users, rows, pictures) ─► demo build + flow (Mac simulator, or EAS via a tunnel)
              ─► capture set (marked AI content) ─► chooseScreens "capture"
              └─► finally: supabase stop --no-backup, workdir deleted, tunnel closed
```

**The automatic pipeline** (`creative/real-screens-auto.ts`): one
resumable state machine per app, persisted in
`<data>/real-screens/<app>/pipeline.json`:

```
cast → approve → seed_plan → flow → flow_merged → capture → done   (+ daily maintenance)
```

Each step first checks the world (is there a cast; is it approved; is there
a seed plan valid for the app's current migrations; is the flow ticket
there; is the flow in the app's checkout or its ticket done; is there a
capture for the current version, newer than the cast's approval) and only
does what's missing — calling it again is a no-op, and a run picks up where
the last one stopped (also after a restart). Per step: status (`pending`,
`running`, `done`, `waiting`, `needs_attention`, `skipped`), attempts, last
error, next retry. A failure is retried with exponential backoff (base 10
min for the cast, 15 min seed plan, 60 min capture; doubling, capped at a
day) up to 5 attempts, then "needs attention" with the reason. Problems day2
can't fix by itself need attention at once: no Docker (or it isn't running)
or no Supabase CLI — with the install hint; no cloudflared for an EAS
capture; a migration that doesn't apply on the temporary database (named;
old captures stay in use); a seed plan that no longer fits the migrations
(the table/column named); no Expo account; not enough credits (`authorize`
for the cast's model + image runs, the vision check and `agent_work` for the
seed plan — the account's balance, app cap and daily cap); a flow PR closed
without merging. A temporary database that didn't start for another reason
(images, ports, health) is retried with backoff. Once a day what needs
attention gets one more try. One run per app at a time (single-flight; the
second caller gets the same promise).

*Triggers* (`realScreensAll` on the backlog timer, every
`DAY2_BACKLOG_TICK_MINUTES`): an app with growth on (the autopilot, or a
connected social account) and real screens missing or stale; daily
maintenance (re-arm what needs attention); a new app version (`app.json`
version differs → the capture step runs again); changed
`supabase/migrations` (a sha256 of names and contents → the cached seed plan
is checked against the new schema, re-stamped if it still fits, otherwise
written again; the next capture applies all migrations to a fresh
database anyway); a post being made — `maybeAutoCapture` kicks
the pipeline, and before the first How it works post waits for it (at most
`DAY2_REAL_SCREENS_WAIT_MINUTES`, default 45). A post never waits for good:
it goes ahead with the best screens there are (`chooseScreens` order) and
the reason is stored (`posts.why`, shown on Formats, logged on the post
run). The pipeline runs for Supabase apps with migrations (else the old
manual path and uploads) — no Supabase organization or access token is
needed; Docker is checked by the capture step; `DAY2_REAL_SCREENS=off`
turns it off.

*Approval policy* (`demoCast: "auto" | "owner"`, per app, default
`auto`, Growth → Formats): in `auto`, day2 approves a cast itself only if
`validateCast` passes, every person and moment has a picture (no
placeholders), and — for AI-made pictures — a vision run (`runVision`,
metered as content generation, ≤ $0.30) finds no text or logos and faces
that clearly look adult. Otherwise (or with `owner`) the step waits with the
reason on Formats. The owner can always Regenerate, Approve or Decline; the
first decline makes a new cast automatically, the second waits for
Regenerate, and a declined cast is never auto-approved. There is no owner
inbox/notification service in day2 today, so "waiting for you" shows only
on Formats (and in the server log).

*The flow PR* follows day2's code rules: the build agent opens it and the
owner merges it (Approvals) — day2 never merges code by itself
(`autonomy.ts` defaults to L2, `pr.ts` never merges). Meanwhile the step
says "Waiting for the flow PR #N to be merged — it's in Approvals".

*Capture in production*: a server without a simulator now uses EAS by
default (`DAY2_CAPTURE=eas` no longer needed; `off` still turns captures
off). When EAS ran but its screenshots can't be fetched, the Android
emulator is tried if the server has one (`androidEmulatorAvailable`: adb,
emulator, Maestro, `ANDROID_HOME`, `/dev/kvm` on Linux;
`DAY2_ANDROID_FALLBACK=off`), else the step needs attention and asks for
uploads.

*Cleanup*: there is no demo database to clean up — each one lives only
for its capture run. Removing an app deletes the cast and its pictures, its
captures, the seed plan and pipeline state; growth off for 30 days deletes
the cast and its pictures (captures and the seed plan stay; a new cast is
written when growth is back). Temporary databases a crash left behind
(`day2cap-…`, older than two hours) are removed by a janitor on startup
and on every backlog tick (`ephemeralJanitor`, per server).

*Migration from standing demo projects* (the earlier design: a Supabase
project `<app>-<id>-demo` per app in day2's organization — rejected: it
doesn't scale, and on a paid plan each one runs all the time, ~$10/month):
on the next tick, an app whose hosting state still records one has it
deleted through the old guard (`retireLegacyDemo` → `deleteDemoBackend`:
only the recorded `-demo` project, confirmed with Supabase first), then the
record and the old demo secrets (`demo_login`, `secret_key:demo`,
`db_password:demo`) dropped. Without `SUPABASE_ACCESS_TOKEN` /
`DAY2_SUPABASE_ORG_ID` the record stays and the pipeline log says to delete
it by hand; a project the guard refuses (renamed or moved) is only
forgotten, never deleted. One that Supabase won't delete when an app is
removed is remembered and retried on the timer. Nothing creates demo
projects any more (`ensureDemoBackend`, pause/resume, the plan-limit
handling and the 30-day project cleanup are gone).

Console (Growth → Formats → Real screens): the steps as a timeline (done /
running / waiting / needs attention, the reason, attempts, Retry or Try
now), the approval setting, the last post's fallback reason. Routes:
`PUT /api/apps/:id/creative/real-screens/settings`, `POST …/real-screens/retry`,
`POST …/demo-cast/decline` (scoped to the signed-in account's app, owner or
admin); `POST …/demo-cast` is Regenerate. The capture card shows the run's
temporary database (starting / ready / removed / failed, with its log
lines and the queue) and what this machine lacks (Docker, the Supabase CLI,
cloudflared for EAS) with install hints.

**Demo cast** (`creative/demo-cast/`): ~8 fictional friends (first names
for the audience's locale, age 18–40 checked — the prompt asks 18–30 —
short bios, "look" words for the photo), friendships (self = the demo
account, 5+ friends, one pending), places with invented names, 8–10
moments (place, caption, minutes ago, what the photo shows), reactions,
comments, a weekly leaderboard. A text-only model run writes it from the
app's purpose/features/audience/tone — never user data — as JSON after a
marker; `validateCast` refuses minors, real names (deny list), handles,
links and emails and drops dangling references; one retry with the
problems, then the seeded built-in cast (`fakeCastDraft`, also the test
fake). Pictures (`images.ts`): the posts' image tool through the creator
kit (caps, credits, own key first) — profile photos as `subject:
"fictional_person"` (prompt describes clothes/hair only and adds
`FICTIONAL_PERSON_RULES`: invented, clearly adult, no text/logos), moment
photos as scenes (no people). Today that's **OpenAI Images**; Gemini is
connected for video only. No tool → the app's bundled demo pictures (e.g.
Dotty's `src/assets/welcome/*.jpg`), else coloured placeholders, and the
card says so. Stored in the asset store (purpose `demo-cast`) with
`aiGenerated`/`aiPerson`; the cast JSON in `<data>/demo-cast/<app>/`.
Regenerate makes a new draft; only an **approved** cast is seeded
(approved automatically or by the owner — see the approval policy above).

**Seed plan** (`hosting/seed-plan.ts`, cached by `hosting/seed-plan-cache.ts`;
Supabase apps with migrations only — others: "not supported yet" + upload)
maps cast entities onto tables as data: per table
`for: people|friendships|places|moments|reactions|comments|leaderboard`
and per column a constant, `{field}`, `{id}`, `{ref}`, `{time}` or
`{image}`, plus upload rules (`{owner}/{id}.jpg`). A model writes it from
the schema read out of the migrations (`schema-introspect.ts`: columns,
required, defaults, generated, references, `in (…)`/`~`/`char_length`
checks, RLS, buckets) or the built-in planner does; `validateSeedPlan`
refuses unknown tables/columns, reserved schemas (auth, storage, …),
generated columns, missing required columns, wrong types, references the
entity doesn't have, tables filled before what they point at, unknown
buckets and unsafe paths. The validated plan is stored in
`<data>/real-screens/<app>/seed-plan.json` with a sha256 of the migrations
(the "Seed plan" step); a failure needs attention naming the table/column
and the newest migration. Dotty: 28 migrations → profiles, friendships,
places, moments, reactions, comments; buckets `dotty-avatars`,
`dotty-moments`; the leaderboard comes from Dotty's own `user_points()`.

**Temporary database** (`hosting/ephemeral.ts`, `creative/demo-session.ts`),
one per capture run, on the machine that runs the capture:

- *Workdir*: `<tmp>/day2-ephemeral/day2cap-<time>-<random>/supabase/` with
  day2's own `config.toml` and a **copy** of the migrations (each prefixed
  with `SET check_function_bodies = off;`, plus PostGIS in `public` when the
  migrations use `public.geography` without creating it) — never run in the
  app's checkout. Config: a unique `project_id` (`day2cap-…`, its time in
  the name for the janitor), a free block of 10 ports (from
  `DAY2_EPHEMERAL_PORT_BASE`, default 55400; checked free and reserved
  in-process, so concurrent runs never collide), the app's schemas in
  `[api] schemas`, `enable_signup = false` (auth and email), no seed file,
  Studio/Realtime/Mailpit/Edge Runtime/analytics/pooler off; the app's
  `[db] major_version` if its config says one (else 17).
- *Start*: `supabase start --workdir <dir> -x studio,mailpit,edge-runtime,imgproxy,logflare,vector,supavisor,realtime,postgres-meta`
  (Postgres, GoTrue, PostgREST, Storage, Kong remain) applies the
  migrations; a failing one is named from the CLI's "Applying migration …"
  output. Then `supabase status -o json` for the **local** anon and service
  keys (held in memory for the run, cut out of every error, never stored or
  logged — they're the CLI's local development keys), and a health wait on
  `/auth/v1/health`, `/rest/v1/` and `/storage/v1/bucket`. Timeouts on every
  step (start 12 min, status 1 min, health 2 min, seed 5 min, stop 2 min,
  queue 45 min). The CLI is pinned (`npx --yes supabase@2.122.1`, or
  `DAY2_SUPABASE_CLI`), and gets day2's environment without tokens, keys
  or passwords.
- *Seed*: one auth user per person through the local Auth admin API (the
  self user gets a fresh random password — this run's demo login, never
  stored), rows as JSON through PostgREST with the service key (the same
  `demoClient` and `expandSeedPlan`, so no SQL is built from the plan),
  pictures into the buckets the migrations create.
- *Reach*: iPhone Simulator → `http://127.0.0.1:<api>` (it shares the Mac's
  network); Android emulator → `http://10.0.2.2:<api>`; EAS → a Cloudflare
  quick tunnel (`hosting/tunnel.ts`: `cloudflared tunnel --url
  http://127.0.0.1:<api>`, only the API port, a random trycloudflare.com
  name, waited for until it answers) passed as the build's
  `EXPO_PUBLIC_SUPABASE_URL`.
- *Teardown*, always (`finally`, also when the start, the seeding, the
  build or the flow fails): tunnel closed, `supabase stop --no-backup`
  (volumes deleted; if it fails, containers/volumes/network are removed by
  the `com.supabase.cli.project` label), workdir deleted, port block and
  slot freed.
- *Limits*: `DAY2_EPHEMERAL_MAX` (default 2) stacks at a time per machine;
  more wait in a FIFO queue (shown on the card).
- *Needs*: Docker with a reachable daemon and the Supabase CLI; missing →
  the capture step needs attention with install hints (Docker Desktop /
  `brew install supabase/tap/supabase`; Docker Engine + Node on a server);
  `cloudflared` for EAS captures.

*Rebuilds per run — the trade-off*: the URL (port, or tunnel name) differs
per run and Expo inlines `EXPO_PUBLIC_*` at build time, so each capture
builds the demo app with that run's values. Captures built per run before
too (local build, or the EAS workflow's build job), so this costs nothing
extra today. A runtime override (a Maestro launch argument or deep link the
demo build reads) would allow reusing one demo build across runs — not
asked of the flow ticket yet because Expo has no built-in launch-argument
API (it would need a native module); worth it only if build minutes become
the bottleneck.

**Flow ticket** (`creative/demo-flow.ts`, source key `creative:demo-flow`,
created after the seed plan is ready): the build agent makes the
Supabase URL/key overridable by `EXPO_PUBLIC_SUPABASE_URL/KEY` (current
values as fallback), allows plain http to the temporary database **in demo
builds only** (iOS `NSAllowsLocalNetworking` / a localhost exception —
never `NSAllowsArbitraryLoads`; Android cleartext only for `10.0.2.2`,
`127.0.0.1`, `localhost` via a network security config), adds an
email/password sign-in shown only when `EXPO_PUBLIC_DAY2_DEMO=1`, an
eas.json `day2-demo` profile without secrets,
`store-screens.yaml` signing in with `${MAESTRO_DAY2_DEMO_EMAIL}` /
`${MAESTRO_DAY2_DEMO_PASSWORD}` (Maestro reads `MAESTRO_*` from its
environment) and `takeScreenshot: day2-shot-<name>` per moment, the
`.json` notes, optionally `social-moments.yaml` with a recording. Nothing
secret is committed.

**Capture** (`creative/capture-run.ts`, wired through `real-screens.ts`):
on the Mac, a clean checkout of main; the run's temporary database is
started from *its* migrations and seeded; the checkout is built for the
simulator with that database's address and public key and
`EXPO_PUBLIC_DAY2_DEMO=1`, installed, the
locale/status bar set (`simctlCommands`; Android: `adbCommands` with
SystemUI demo mode), and the flow run with the login in Maestro's
environment only (cut out of error text). Without `maestro` on PATH the
card shows `curl -fsSL "https://get.maestro.mobile.dev" | bash`. With
EAS (the default on a server without Xcode): eas.json gets the `day2-demo`
profile with the tunnel address and the local public key, and `.eas/workflows/day2-capture.yml` is written into the temporary
checkout (build → `type: maestro` job with `environment: preview`,
`record_screen`, and an `after_maestro_tests` hook running
`eas/upload_artifact` for `day2-shot-*.png`); the run's login goes in as
`secret` EAS variables and is deleted after the run (`eas env:delete`, in
`finally`); after `eas workflow:run --wait`, `eas workflow:view
--json` is searched for the artifact's link, downloaded with
`safeDownload` (host list `eas`), archives unpacked (no absolute paths,
"..", or symlinks followed). The EAS docs don't document how to fetch
artifacts from the CLI — **unverified**; if no link comes back the card
says so and the Mac path stays. One capture per app at a time, status +
log polled by the console, the temporary database removed afterwards. Triggers:
**Capture screens** (Formats) and the automatic pipeline above (a new app
version, the first How it works post, daily maintenance).

**AI label**: a capture of the demo cast is marked `aiContent`; the studio
stores its assets with `aiGenerated/aiPerson`, writes IPTC
`DigitalSourceType = compositeWithTrainedAlgorithmicMedia` XMP into every
JPEG slide/cover (what Meta reads for "AI info"), sets TikTok `is_aigc`,
and the post's `creative.aiContent` explains it on the card.

**Upload** (`creative/upload.ts`): 3–8 PNG/JPEG phone screenshots per
language, ≤ 10 MB each / 60 MB together, magic bytes checked, size and
portrait shape read from the header before decoding, re-encoded by ffmpeg
with the image demuxer forced and `-protocol_whitelist file`, metadata
dropped (EXIF/GPS gone), stored per app and locale; warning on the page to
use a demo account, never real friends.

Sample: `bun run src/creative/demo-cast/sample-cli.ts <dotty repo> <out>`
writes the cast (fake model, Dotty's bundled pictures), the seed plan and a
rows preview for Dotty's migrations, the flow ticket, mock screens filled
with the cast and a How it works post from them.

## 3. Motion engine and templates

**Engine** (`motion/engine.ts`): a composition is HTML with all CSS
animations on one paused timeline; each frame seeks every animation and is
captured through the DevTools protocol, piped to ffmpeg. Deterministic,
offline (fonts, screens, icons are data URIs; network blocked), text is
fitted in the page so long German compounds never break. **Sound**
(`motion/audio.ts`): whooshes on cuts, taps on taps, a pop on reveals — all
synthesised by ffmpeg — over the app's music bed from ElevenLabs when Posts
may use it, else a quiet built-in beat. Output: H.264 High / AAC 48 kHz
stereo / 30 fps / 2 s GOP / faststart.

**Templates** (`templates/`), each a 9:16 video and/or 4:5 + 1:1 slides,
in the brand kit's colours, fonts, radii, stickers and real icon:

| Template | Video | Stills | Story |
|---|---|---|---|
| How it works | ✓ | carousel (cover, 1 slide per step, end) | hook → steps with number badge, real screen, camera zoom, tap ripple, word-by-word captions → end card |
| What's new | ✓ | carousel | same, "New" badges, version, from App Store "What's New" |
| Feature spotlight | ✓ | 1 still | hook → one screen, camera moves between details → end card |
| POV hook | ✓ | — | b-roll (owner clip or photo, creator tools) with the POV line → hard cut to the app → end card |
| Problem → solution | ✓ | 2 slides | grey "before" chat bubbles → brand-colour circle wipe → the app answering it |
| Launch | ✓ | 1 still | real icon on the brand's burst, the announcement slams in, screens fan out |

Design rules baked in: safe zones for TikTok/Reels on 9:16 (text between
y 230–1500, clear of the right-hand buttons), a type scale (hook 150 px,
headline 96, captions 46, never under 30 at 1080 wide), easing curves
(expo-out entrances, overshoot pops, symmetric camera moves), one idea per
frame, the dotted trail and stickers as accents. Carousels are rendered as
one panorama, so the trail runs across slides as you swipe.

### Remotion (decision)

Not used. Remotion does the same thing (headless Chromium frames → ffmpeg)
behind a React/webpack bundle; day2's compositions are data-driven
templates the art director fills with a shot list — nothing would use
React authoring, and the in-house engine needs no bundle step, no extra
compositor binaries and no telemetry. Licence (remotion.dev/docs/license,
checked 2026-11-08): free for individuals and organisations of up to 3
people; companies need a Company License — **"Automators" $0.01 per render,
$100/month minimum** (required for code that calls the render APIs, i.e.
day2's pipeline), Enterprise from $500/month; AI-generated compositions are
allowed; customers may not upload their own Remotion code; Remotion 5 makes
server-side telemetry mandatory for Automators. If gora8 ever switches,
that's the licence it needs (go-live checklist).

## 4. Art director and design critique (the taste layer)

**Art director** (`art-director.ts`). Picks the template
(`chooseTemplate`): the owner's pick ("Make a How it works post") → How it
works for an app with < 3 posts that never had one (also on first connect)
→ What's new within 3 days of a release with notes → else fit to the idea
(topic/hook) × the owner's liking per template, sampled (POV only with
b-roll). Then one vision run looks at the real screens and writes the shot
list: hook, kicker, per step headline/caption/screen/focus box/tap/sticker,
CTA, end line — in the audience's language and the app's UI tone, against
the rubric. Its JSON is clamped (word counts, regions, screen indices,
stickers the app has); without credits or on failure a plain shot list is
built from the idea and the screens.

**Critique** (`critique.ts`) after every render:
1. *Layout facts* day2 knows exactly from where it put text (`__layout` at
   the sampled times): text in TikTok/Reels UI zones, text too small, cut
   off, more than 4 text elements at once, screens in another language, no
   icon. These cap the scores (a blocker → 3/10).
2. *Vision critic*: the sampled frames (first second, each step, end card)
   and slides, scored 0–10 on the rubric's 10 criteria, with concrete fixes
   and a one-line "why this works".

Pass = weighted score ≥ 7 and no blocker criterion under 6. Otherwise the
fixes go back to the art director and it re-renders — at most 2 more
rounds; what still fails is dropped with the reason in the Social log and
never shown. Score, rubric version, rounds, issues and "why this works"
are stored on the post (`post.creative`) and shown on the card.

### Improving the taste file ("training")

- `src/creative/taste/rubric.v1.md` — criteria, weights, blockers, good and
  bad. To change it, add `rubric.v2.md`, bump `CURRENT_RUBRIC` in
  `taste/index.ts` (and `CRITERIA` if criteria change). Never edit a
  published version: posts keep the version they were judged with, so
  scores stay comparable.
- `src/creative/taste/examples.json` — short good/bad descriptions the
  director and critic see. Add an entry when the owner rejects something
  for a reason that generalises ("small phone on grey").
- Per app, automatically: every approve / decline (with the owner's why) /
  edit / "Use this one" / passed-over variant is counted per template in
  `day2-creative.json` (`templateLiking` = Beta(2,2) over picks vs declines);
  the liking weights template choice and the director sees the owner's
  reasons. Declines also go to memory as before (90 days).

## 5. Carousels end to end

Post kinds `video | image | carousel`; slide formats `ig_carousel`,
`fb_album`, `tiktok_photo` carry `target.assetIds` (slides in order). A
designed variant goes out as an Instagram carousel + Facebook multi-photo
post (4:5 slides) and as a TikTok video (the animated version); TikTok
photo mode is used when there's no video.

- Instagram: one `is_carousel_item` container per slide → `CAROUSEL`
  container with `children` and the caption → status → `media_publish`
  (2–10 slides).
- Facebook: each photo `published=false` → one `/{page}/feed` post with
  `attached_media[n]`; a retry looks the post up first.
- TikTok photo mode: `/v2/post/publish/content/init/` with
  `media_type: PHOTO`, `post_mode: DIRECT_POST`, `source_info.source:
  PULL_FROM_URL`, `photo_images` = day2's public media links
  (`https://app.gora8.com/api/assets/sm_…jpg`, expiring), cover 0, title
  ≤ 90 chars, `auto_add_music`; then the usual status fetch. Needs the
  domain/URL prefix verified for the TikTok app (gora8.com is).
- Metrics: carousels read like feed posts (Instagram insights; Facebook
  post reactions/comments/shares).
- Approval UI: slide strip with ← → to reorder, **Edit the words on the
  slides** (re-rendered and layout-checked; too-long words are refused),
  template, design score, "why this works", the screens warning.

## 6. Variants and "How it works" for new apps

With "Posts go out on their own" off, day2 renders 2 variants per idea
(different templates; `DAY2_CREATIVE_VARIANTS=1` for one). The owner sees
"Version 1 of 2 · Use this one"; Approve waits for the pick; the other
version is set aside ("You picked the other version", not a decline of the
idea); both feed the learning. The first post for a new app (and on first
connect) is a How it works post; **Make a How it works post** on Growth →
Posts makes one any time. The slides use the same renderer the store
screenshot pipeline could use (separate APIs, shared `render.ts`).

## 7. Design sources beyond the repo (optional)

- **Figma**: Growth → Formats → Figma (file link + personal access token,
  stored encrypted with `DAY2_SECRETS_KEY`, never returned): published
  colour and text styles via `GET /v1/files/:key/styles` + `/nodes`. Not the
  Figma MCP server: day2's connectors framework (`src/connectors.ts`) runs
  remote MCP servers with OAuth inside agent runs; Figma's MCP server is the
  Dev Mode server (desktop app, local) or the remote one that needs a Dev
  Mode seat and interactive sign-in — wrong fit for a server-side pass that
  just needs styles. The Variables API would be better but is Enterprise-only.
- **Owner clips** (b-roll for POV posts): Growth → Formats → Your clips
  (MP4/MOV/JPEG/PNG ≤ 60 MB), stored app-scoped in the asset store like
  other media, served only via the signed-in, app-scoped preview route.
- Considered, not used: **Canva** (Connect API / MCP) — good for
  human-edited designs, but renders are template-locked and per-seat, and
  day2 needs deterministic, code-driven video; **Runway/Luma/Google** stay
  the b-roll sources (creator-tools.md); **Mobbin/Screenlane** for
  reference — would help the art director's examples, no API fit yet.

## 8. API

| | |
|---|---|
| `GET /api/apps/:id/creative` | brand kit (extracted + overrides + resolved), screens source/warning, capture plan, templates with samples and the owner's tally, clips, taste |
| `PUT /creative/brand-kit` · `POST /creative/brand-kit/refresh` | owner edits · read again |
| `POST /creative/samples` · `GET /creative/samples/:template.jpg` | render the gallery in the app's look |
| `GET /creative/icon` | the app icon (signed in) |
| `POST /creative/broll` | upload a clip (raw body) |
| `PUT /creative/figma` · `DELETE` | connect / disconnect Figma |
| `POST /social/posts/make` `{template?}` | make a post (optionally a template) |
| `POST /social/posts/:post/pick` | Use this one |
| `PATCH /social/posts/:post` `{slideOrder?, slideTexts?}` | reorder / re-word slides |
| `POST /creative/demo-cast` · `/demo-cast/approve` · `GET /demo-cast/images/:asset` | write (background) / approve the demo cast; its pictures (app-scoped) |
| `PUT /creative/real-screens/settings` · `POST /creative/real-screens/retry` `{step?}` · `POST /creative/demo-cast/decline` | approval policy · retry a pipeline step (e.g. `seed_plan`, `capture`) · decline the cast |
| `POST /creative/capture` | capture now (background; status in `GET /creative` → `real.capture`) |
| `POST /creative/screens` (form: `language`, `files`) · `DELETE /creative/screens/:locale` · `GET /creative/screens/:locale/:file` | the owner's screenshots |

All scoped to an app of the signed-in account; changes need an owner or
admin. Env: `DAY2_CREATIVE_STUDIO=off` (old built-in media),
`DAY2_CREATIVE_VISION=off` (layout checks only, no vision runs),
`DAY2_CREATIVE_VARIANTS=1`, `DAY2_VISION_MODEL`, `DAY2_CAPTURE=local|eas|off`,
`DAY2_DEMO_CAST_MODEL=fake`, `DAY2_EPHEMERAL_MAX` (default 2),
`DAY2_EPHEMERAL_PORT_BASE` (default 55400), `DAY2_SUPABASE_CLI`.

## 9. What's honest

- No simulator here: the Dotty samples use **mock captures** rebuilt from
  Dotty's own tokens, fonts, 3D icons and demo pictures
  (`src/creative/fixtures/dotty-mock-screens.ts`, optionally filled with a
  demo cast). The capture path is tested with fake devices and a fake EAS,
  not run on a Mac or EAS yet.
- The temporary database is tested with a fake docker and a fake Supabase
  CLI (lifecycle, teardown on failure, ports, queue, janitor), the tunnel
  with a fake cloudflared. Run for real in day2's build sandbox (Docker
  29.9, `supabase@2.122.1`): the CLI accepted day2's generated config.toml
  and `-x` list for Dotty's 28 migrations and got as far as pulling
  Supabase's images, which that sandbox's network refuses
  (public.ecr.aws → 403); day2 reported it as "Docker couldn't download
  Supabase's images", ran `supabase stop --no-backup` and removed the
  workdir; the janitor's docker label queries ran against the real daemon.
  So Dotty's migrations have **not** yet been applied to a fresh local
  stack — they reference a legacy table (`public.places_osm`) in function
  bodies (hence `check_function_bodies = off`) and need PostGIS (in the
  local image); a migration that still fails is named on the capture card.
  First run on the Mac is the real test.
- The seed-plan model run and the cast model run are tested with fakes; the
  built-in planner is what's verified against Dotty's real schema.
- Focus boxes come from the art director looking at screenshots; they can
  be off by a bit — the zoom then shows the neighbourhood of the element.
- The vision critic is a model; the layout checks are exact. Both are
  tested with fakes; the real critic hasn't judged a real post yet.
- The built-in beat is a placeholder bed; trending sounds can't be added
  through the APIs (TikTok's `auto_add_music` only for photo posts).
- Carousel publishing is built from Meta's and TikTok's docs and tested
  against fakes, like the rest of Social.
