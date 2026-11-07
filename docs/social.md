# Social: organic posts on the owner's Instagram, Facebook Page and TikTok

day2 makes posts for each app, the owner approves them (by default), day2
publishes them on the owner's **own** accounts at a good time, reads how they
did, and makes the next ones better. Free channel: it runs in the launch stage
(<100 active users), where paid ads stay locked (growth-strategy.ts).

> **Not run against real accounts yet.** Everything below is built from
> Meta's and TikTok's documentation (checked November 2026) and tested against
> scripted fakes of their APIs. The console says so on the Social page. The
> first real run is Dotty (see "First run with Dotty").

Code: `src/social/` (types, store, meta, tiktok, make, safety, schedule,
publish, feedback, pass, runtime, routes). Console: **Social** in the app's
sidebar (`/apps/<id>/social`), a tile on Home, a line on Approvals, the same
switch on Autonomy, and server setup on Platform.

## What the owner does, per app

1. **Social → Instagram / Facebook → Connect with Facebook.** Sign in, keep
   every permission switched on, pick the Facebook Page. The Page's linked
   Instagram professional account gets the Instagram posts. (The Page sign-in
   on Ads asks for the same permissions, so connecting there also sets this up.)
2. **Social → TikTok → Connect TikTok.** Sign in to TikTok and allow access.
3. Optional: turn on **Posts go out on their own** (off by default), pick the
   platforms to post on, or **Pause all posting**.
4. Each post: look at the preview, change the words per platform if needed,
   pick a time, then **Approve** — or **Not this one** with a short "Why not?"
   (day2 remembers and won't propose the same again for 90 days). TikTok posts
   also need the owner's TikTok choices (below).

## What day2 does

**Making posts** (`make.ts`, on the autopilot timer when the autopilot is on):

- How many: the growth strategy's `social_content` frequency (launch: 3 a
  week). At most one new post a day, and none while 3 are waiting for the owner.
- Format: the growth allocator's social_content arms (Thompson sampling on this
  app's own results): Motion video from the app's real screens, a walkthrough
  recording (web apps), an AI presenter video (only with Creatify set up), or a
  still image.
- Words: one writer run with the app profile, Brand DNA (social channel note),
  `memoryFor(app, 'social')`, the owner's declined ideas, what worked for this
  app (openings, topics) and for similar apps (cross-app learning,
  `social.*` kinds), and the week's trend research. In the audience's language
  (Dotty: German, casual "du"); the owner can change it in settings.
- Checks before the owner sees it: the content safety check (`safety.ts`: no
  invented numbers, rankings or testimonials, no superlatives, no competitor
  names, no health/medical or money/finance promises, nothing unsuitable for a
  young audience, no emails, phone numbers or @handles, caption and hashtag
  limits per platform), plus day2's two agent checks (truthful claims,
  authenticity). A generic-sounding idea is dropped before any media is made;
  a post with issues is **held back** until the owner fixes the words.
  Every edit runs the check again.
- Media per platform: 9:16 H.264 High / AAC 48 kHz stereo / 30 fps / 2 s GOP /
  moov first (ffmpeg) for Reels, Facebook Reels, Stories and TikTok; JPEG 4:5
  for feed and Facebook photo posts; JPEG 9:16 for Story images. Videos ≤ 60 s.
- Posts: one for Instagram + the Facebook Page, one for TikTok (same media).
- Time: the next good slot ≥ 3 h ahead in the audience's time zone (Dotty:
  Europe/Berlin), one post per day per platform family. Until there are
  results: Instagram evenings (19:00) on weekdays, midday at weekends; TikTok
  evenings / afternoons; Facebook midday. Once at least two time slots have 3
  measured posts each, the best one wins (15 % exploration).

**Publishing** (`publish.ts`, every 15 minutes):

- Only approved posts at or after their time. Nothing while the app's kill
  switch (Budget) or the Social pause is on.
- Through growth-execution.ts's gates (`executeChannelAction`, the
  `performLiveAction` seam is now wired for `social_content`): claims check,
  kill switch; free organic posts spend nothing.
- Limits: day2 posts at most 3 times a day on Instagram, 3 on Facebook, 2 on
  TikTok (far below Instagram's 100 API posts per 24 h, Facebook Reels' 30 and
  TikTok's ~15 per creator). Instagram's own count
  (`content_publishing_limit`) is checked before every publish; TikTok's
  `spam_risk_too_many_posts` waits a day.
- Never twice: a target is claimed with a 10-minute lease inside the post's
  row lock; every id a platform returns (container, video, publish id) is
  saved at once and the next step continues from it. If a try ended in the
  unknown: Instagram's container says `PUBLISHED` → the media is looked up,
  not posted again; a Facebook photo post is looked up among the Page's recent
  posts first.
- Failures: retries with backoff (5 min, 10, 20, … up to 6 h), at most 5
  attempts; a platform error that won't change (4xx) is final at once, with
  the platform's reason shown to the owner. Tokens never appear in errors.
- Public media: Instagram and Facebook fetch media by URL. day2 serves each
  post's file at `/api/assets/sm_<32 random bytes>.<ext>` (the existing public
  path, no new tunnel route), valid 48 h until the post goes out and 24 h
  after. Social media is never served by its asset id; the console preview
  uses a signed-in, app-scoped route.

**Feedback** (`feedback.ts`):

- Results per post at 24 h, 72 h and 7 days: Instagram insights (reach, views,
  likes, comments, shares, saved, follows for feed posts; Story: reach, views,
  shares, follows, replies); Facebook (reactions, comments, shares from the
  post; views best-effort from insights — see "Not verified"); TikTok
  (`/v2/video/query/`: views, likes, comments, shares — public posts only).
- 72 h: engagement per view (likes + 2·comments + 3·shares + 3·saves +
  5·follows, over views) → reward in [0,1) (0.5 at the app's usual) → the
  allocator arm for the format (`recordWeightedOutcome`) and this app's scores
  for its opening, topic and time slot.
- 7 days: better / worse / no clear change against the app's median (from 5
  measured posts on) → cross-app learning (`social.format`, `social.hook`,
  `social.topic`, `social.post_time`, metric `engagement_rate`, source
  `social`; fixed words only, through the existing privacy filter). A post at
  ≥ 1.5× the usual is a **boost candidate** — shown, and only usable once paid
  ads unlock.
- Installs: Facebook posts carry the app's smart link with the tag
  `social.fb` (taps counted). Instagram captions and TikTok can't link (and
  Story link stickers can't be published through the API): the owner can put
  `https://<domain>/api/l/<app>?d2=social` in the bio. Otherwise installs are
  an **estimate**: installs (Numbers: App Store downloads + Play installs) on
  the post's day and the next, above the 7 days before and only beyond twice
  the usual spread, shared between that day's posts — always labelled as an
  estimate.
- Every published post is a line in the growth feed (`day2-growth-actions.jsonl`,
  executed).

## TikTok's rules (content sharing guidelines) and how day2 follows them

- Creator info is fetched fresh when the post form is shown and again on
  approve: the account's nickname, privacy options, comment/duet/stitch
  settings, the longest video allowed.
- Visibility: a dropdown from the account's own options, **no default**.
- Comment / Duet / Stitch: off by default; greyed out when the account turned
  them off.
- Commercial content: off by default; when on, "Your brand" and/or "Branded
  content" must be ticked; branded content can't be private; the matching
  declaration ("By posting, you agree to TikTok's Music Usage Confirmation" /
  "…Branded Content Policy and Music Usage Confirmation") is shown.
- AI presenter videos are labelled AI-generated (`is_aigc`).
- The owner sees the preview and can edit every text; day2 adds no watermark.
- **TikTok posts always wait for the owner**, even with "Posts go out on
  their own" on: TikTok requires the creator's express consent per upload.
- **Audit pending:** until TikTok audits day2's app, only `SELF_ONLY` is
  offered — the console says "TikTok audit pending: posts are private", and a
  published post says "Posted as private (only you can see it)". Unaudited
  apps are also limited to 5 posting creators per 24 h.
- Direct Post with `FILE_UPLOAD` (chunked: whole under 5 MB or up to one
  10 MB chunk, else floor(size/10 MB) chunks with the remainder in the last),
  so no domain verification is needed. **Photo posts** need `PULL_FROM_URL`
  and a verified domain or URL prefix in the TikTok developer portal; day2
  doesn't make TikTok photo posts yet (the `tiktok_photo` format exists in the
  store for later).

## Why Facebook Login (and not "Instagram API with Instagram Login")

Meta offers two ways to publish on Instagram:

| | Facebook Login (chosen) | Instagram Login |
|---|---|---|
| Account | Instagram professional (Business **or** Creator) linked to a Facebook Page | Instagram professional, no Page needed |
| Host / token | graph.facebook.com, Page access token | graph.instagram.com, Instagram user token (60 days, refresh) |
| Scopes | `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_*` | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights` |
| Facebook Page posts | yes, same sign-in | no |
| Resumable video upload | yes (rupload.facebook.com) | no |

day2 already has the Meta app and the owner's Page sign-in (Ads → Page), the
Page is needed for Facebook posts anyway, and a Page token from a long-lived
user token doesn't expire. So one Facebook sign-in covers the Page and its
Instagram account. An owner with an Instagram account that isn't linked to a
Page sees "Missing: an Instagram professional account linked to the Page" and
links it in Instagram (Settings → Account type and tools / Linked accounts).
Instagram Login could be added later for owners without a Page.

Business vs. Creator: Meta's content publishing docs require a professional
account; both types publish Reels and feed posts this way. Meta's docs have in
the past limited Story publishing to Business accounts — not verified; if Meta
refuses a Story, that target fails with Meta's reason and the Reel/feed post
still goes out.

## Operator setup

See [operator-setup.md](operator-setup.md) §2d/2f (Meta: products, the new
permissions for App Review) and §3d (TikTok Content Posting API).

- Env: `META_APP_ID`, `META_APP_SECRET` (the same Meta app as ads; optional
  `META_API_VERSION`, default v26.0; `META_LOGIN_CONFIG_ID`, recommended for
  Business-type Meta apps, makes the sign-in use that Facebook Login for
  Business configuration instead of a scope list, optional override
  `META_LOGIN_CONFIG_ID_SOCIAL`), `TIKTOK_CONTENT_CLIENT_KEY`,
  `TIKTOK_CONTENT_CLIENT_SECRET` (a separate TikTok app from the Marketing
  API's `TIKTOK_APP_ID`), optional `TIKTOK_CONTENT_API_BASE`.
- Redirect URIs: `https://<domain>/api/ads/connect/callback/meta` (already
  registered for ads) and `https://<domain>/api/ads/connect/callback/tiktokposts`
  (new; it fits the public callback pattern `[a-z]+`, so no tunnel change).
- `DAY2_PUBLIC_URL` must be public https: Instagram and Facebook fetch media
  from it.
- Platform → Ad accounts shows what's missing for social posting, with both
  redirect URIs.
- Database: migration `026_social.sql` (`social_accounts`, `social_posts`,
  `social_media_links`). Locally: `.day2-social-accounts.json` (0600,
  encrypted tokens), `social/posts.json`, `social/media-links.json` in the
  data folder, `day2-social.json` next to the app.

## API

All under `/api/apps/:id/social` and scoped to the signed-in account's app;
changes need an owner or admin. Tokens are never returned.

| | |
|---|---|
| `GET /social` | connections, what each platform can do, settings, posts, results, log |
| `PUT /social/settings` | `autoPublish`, `paused`, `platforms`, `language` |
| `POST /social/connect/meta` · `GET/POST /social/connect/meta/:pending` | Facebook sign-in, then pick the Page |
| `POST /social/connect/tiktok` · `GET /api/ads/connect/callback/tiktokposts` | TikTok sign-in |
| `DELETE /social/accounts/:network` | disconnect `meta` or `tiktok` |
| `GET /social/tiktok/creator` | fresh creator info for the post form |
| `POST /social/posts/make` | make a post now |
| `PATCH /social/posts/:post` | words per platform, hashtags, time, TikTok choices |
| `POST /social/posts/:post/approve` · `/decline` | approve; "Not this one" (`reason`) |
| `GET /social/media/:asset` | preview (signed in) |

## What's verified and what isn't

- **Tested (fakes):** container polling, the publishing limit, crash recovery
  without double posts, Facebook photo and Reel phases, TikTok creator info →
  init → chunked upload → status, TikTok's choice rules, backoff and final
  failures, daily limits, kill switch and lease, autonomy switch, safety
  check, scheduling across DST, feedback windows → allocator / learning /
  boost, expiring media links, tenant scoping on every route, tokens never
  returned (`src/social/*.test.ts`, console `e2e/social.spec.ts`).
- **Not run against real accounts:** every Graph and TikTok call.
- **Unverified details:** Facebook Page post views (`post_media_view`,
  `post_total_media_view_unique`) and Reel views (`blue_reels_play_count`) —
  Meta renamed Page metrics in 2025; reactions/comments/shares come from the
  post itself and are reliable. Whether Facebook Login for Business needs a
  login configuration id instead of a scope list for these permissions. Story
  publishing on Creator accounts. TikTok's exact behaviour for unaudited
  clients beyond `SELF_ONLY`.
- **Not built:** TikTok photo posts (needs domain verification), Instagram
  carousels, per-post links on Instagram/TikTok (APIs don't allow them),
  boosting (only flagged), Instagram Login for accounts without a Page.

## First run with Dotty

1. Operator: App Review isn't needed for accounts with a role on the Meta app
   — add Dotty's owner as a tester (App roles), and the TikTok account as a
   target user in the TikTok app's sandbox.
2. Dotty → Social: connect Facebook (pick Dotty's Page with its Instagram
   account), connect TikTok.
3. **Make a post now**; check the German text, approve it with a time a few
   minutes ahead; TikTok: "Only me".
4. Watch the post appear; after 24 h, check the results line. Send any error
   shown on the post (it never contains a token).
