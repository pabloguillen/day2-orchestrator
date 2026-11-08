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

Fallback order (`chooseScreens`): fresh captures in the language → the store
screenshot pipeline's raw captures for that locale → App Store screenshots
with a **"Screens are in English"** warning on the post card (and the
critique counts it) → web screenshots. Screens can't be re-rendered in
another language (they're pictures), so day2 never silently mixes.

Clean frames: the status bar is cropped off in cards, screens are shown
large and bleeding off the edge (no device frame), and every template
zooms to / lifts off the region that matters.

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

All scoped to an app of the signed-in account; changes need an owner or
admin. Env: `DAY2_CREATIVE_STUDIO=off` (old built-in media),
`DAY2_CREATIVE_VISION=off` (layout checks only, no vision runs),
`DAY2_CREATIVE_VARIANTS=1`, `DAY2_VISION_MODEL`.

## 9. What's honest

- No simulator here: the Dotty samples use **mock captures** rebuilt from
  Dotty's own tokens, fonts, 3D icons and demo pictures
  (`src/creative/fixtures/dotty-mock-screens.ts`). The capture path is
  unit-tested (commands, plan, fallback), not run on a Mac yet.
- Focus boxes come from the art director looking at screenshots; they can
  be off by a bit — the zoom then shows the neighbourhood of the element.
- The vision critic is a model; the layout checks are exact. Both are
  tested with fakes; the real critic hasn't judged a real post yet.
- The built-in beat is a placeholder bed; trending sounds can't be added
  through the APIs (TikTok's `auto_add_music` only for photo posts).
- Carousel publishing is built from Meta's and TikTok's docs and tested
  against fakes, like the rest of Social.
