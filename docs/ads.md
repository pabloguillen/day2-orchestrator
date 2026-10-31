# Ads on every platform

day2 runs an app's paid ads by itself:
- It makes the ads (images, videos, text).
- It launches them on every platform it can.
- It reads the results.
- It moves the money to what works.

**Whose ad account**, per app and per platform:
- **day2's own** (the default). The spend is billed to the customer's credits at the paid-ads markup (`credits.ts`). Customers never see day2's own costs; the console and the autopilot log show credits only.
- **The customer's own**, connected in one click on **Growth → Ads**. The customer pays the platform directly; day2 bills no credits for that spend and shows it in the account's own currency.

day2 picks the app's own account if there is one, else day2's connected account, else day2's account from the server environment (older setups) — `resolvePlatforms` in `ads/registry.ts`. Budgets are set in the account's currency, converted with ECB rates (`ads/fx.ts`).

## Connecting (one click)

Everything a person connects goes through the platform's own sign-in (OAuth); nobody pastes tokens. `ads/connect-flow.ts`:

1. **Start**: the console asks for the platform's sign-in page and sends the person there.
2. **Back at day2** (`/api/ads/connect/callback/:platform`, public): the tokens are kept, encrypted, with the half-done connection (1 hour at most), and the person lands back on the page they started from.
3. **Pick**: the ad account (accounts that can't spend are shown but can't be picked), then — on platforms where ads show as the app's own page — the page. day2 checks once more that the account can spend before saving it.

Who connects what:
- **day2's operator**, on **Platform → Ad accounts**: day2's own account on each platform. The same page checks the server: public https address, encryption key, ffmpeg, Chromium, Creatify.
- **The app's owners and admins**, on **Growth → Ads**: their own ad account (optional) and their page.

**Pages that need an approval.** With day2's account, day2 asks for access to the app's page in the same step where the platform allows it (Meta Page access request, LinkedIn Sponsored Content Poster role). Until the page's admin approves, the platform shows "Waiting for approval" with what to do; day2 checks again on every pass and starts by itself. A page can also be linked by its id when one-click isn't available.

**Server environment.** Only day2's developer-app keys live in the environment; every connected account is stored encrypted in the database (`ad_connections`, `DAY2_SECRETS_KEY`). Locally, day2 makes its own key once.

| Platform | Developer app keys |
|---|---|
| Meta | `META_APP_ID`, `META_APP_SECRET` (+ `DAY2_META_BUSINESS_ID` for Page access requests) |
| TikTok | `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` |
| Google | `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| Snapchat | `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET` |
| Pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| X | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET` |

Each developer app's redirect URL is `<DAY2_PUBLIC_URL>/api/ads/connect/callback/<platform>`. A platform without its keys shows "Not available yet" to customers and the missing names to the operator.

## How a pass works

The ad pass runs on the growth autopilot's timer. The code is in `src/ads/autopilot.ts`.

1. **Experiments are the unit.** Each live experiment (`growth-bets.ts`) gets ads once its page is live. This requires three things:
   - the app has a growth budget (40% of it goes to ads);
   - paid traffic makes sense for its stage;
   - the credits cover a week.
2. **Platforms.** day2 takes the platforms it has an account on where the app's identity is ready (see below), in the order that suits the audience:
   - consumer: Meta, TikTok, Google, Snapchat, Pinterest, Reddit, X;
   - business: LinkedIn, Google, Meta, X, Reddit.

   It takes as many as the budget covers at each platform's minimum daily spend, at most 4. An experiment starts at half its share of the budget and earns the rest by working.
3. **Words** (`ads/copy.ts`). One writer produces:
   - 2 variants, each with every short form the platforms need;
   - a script for an AI presenter, who speaks as a narrator and never as a real customer;
   - search keywords and interests;
   - the markets to run in.

   Two independent checks then run on every variant and the script: truthful claims, and authenticity (no generic AI copy, no fake testimonials). Whatever fails is left out, and the log says why.
4. **Content** (`ads/produce.ts`, `ads/content.ts`), made once per experiment in every format the chosen platforms need:
   - **Images.** The app's real landing page, as a phone screenshot, in a frame with the brand colour, headline and button. One image per ratio per variant.
   - **Walkthrough videos.** A real screen recording of the page, composed into the same frame with ffmpeg. It only scrolls: nothing is tapped or typed on the live app. Each video gets a cover image and an audio track.
   - **Motion videos** (`ads/motion.ts`). Animated product ads made in-house: kinetic headline, the app's real screenshots moving in a phone frame, benefit lines, end card with the button. Rendered frame by frame in Chromium and encoded with ffmpeg — no vendor, nothing generated: every screen is a real screenshot and every word is checked copy.
   - **AI presenter videos (Creatify).** Made when Creatify is connected and the script passed both checks.
   - **Generated motion shots (Runway).** Off by default; switch on with `DAY2_ADS_RUNWAY=on`.

   Generated video is capped at $12 per experiment (before markup) and billed as content generation. Files are kept on day2's disk and served at `/api/assets/<unguessable id>`, because most platforms fetch media by URL.
5. **Launch.**
   - Each platform gets the ads that fit its formats: videos where it takes them, else images. Google runs search ads built from the keywords.
   - Each ad gets its own tracked link (`?d2=B-4.tiktok.v1`: experiment, platform, ad). That lets day2 see in its own usage events who came from which ad, measured the same way on every platform.
   - Once a platform has received enough sign-ups from day2 (15 in a week), new campaigns there optimise for sign-ups instead of clicks.
   - Campaigns are created paused and switched on only once every part exists. If a launch fails halfway, what was created is removed.
6. **Every pass after that.** Results are read every 6 hours.
   - **Billing:** spend is billed in credits as it's reported, and never twice.
   - **Rejected:** a rejected ad is stopped on that platform, and the platform's reason is logged.
   - **Broken page:** its ads are held until the page works again (field checks).
   - **Budget used:** when the month's ad budget is used, everything is held until the new month.
   - **Conversions back to the platform.** Each sign-up from an ad is sent to that platform's conversions API (click id, plus the visitor's IP and browser where the platform needs them), once. That's what lets the platform find more people like them.
   - **What an ad is judged on** (see "Ads and retention" below): cost per result, adjusted for **fit** — whether the people it brings stay as well as other new users who started at the same time. Never by absolute retention.
   - **Inside a platform**, an ad whose fit-adjusted cost is 2.5× the best ad's (or that spent without a result) is paused; the others keep running.
   - **Comparing platforms**, per experiment, after 3 days and enough spend, by fit-adjusted cost per result:
     - a platform that spent without a single result is stopped;
     - one that costs more than 2.5× the best is cut to its minimum, or stopped if it's already there;
     - the best gets 1.5× more, at most weekly — unless scale-ups are on hold for the retention engine (below).
   - **Worse overall:** an experiment that brings people who do worse than everyone else is stopped everywhere.
7. **What day2 learned** (`ads/learnings.ts`), ranked by fit-adjusted cost, recomputed every pass and used by the next round:
   - **Words:** headlines that brought the cheapest results, and the ones (and angles) that failed, go to the copy writer.
   - **Formats:** a format that lost twice and never won isn't made again.
   - **Platforms:** new experiments start with the platforms that did best for this app.
   - **Research:** angles that worked and failed go into the next market research.
   - **Growth allocator:** every ad's people and results count as format trials, once.
8. **Kill switch.** The kill switch, or turning the autopilot off, pauses every ad on every platform.

## Ads and retention

An ad brings people to the product. Whether they stay is mostly the product and day2's retention engine (`docs/retention.md`). So the two are judged separately and connected on purpose (`ads/results.ts`, `ads/retention-link.ts`, `retention-pass.ts`):

- **Ads are judged on what they control.** Cost per result, adjusted for fit. Fit compares the people an ad brought with *other new users who started in the same weeks* — same product, same retention treatments (holdouts are random, independent of source), so the retention engine's effect cancels out and what's left is whether the ad attracted the right people with the right promise. Fit is shrunk towards 1 when there are few users (10-user prior), bounded to 0.5–1.5, and unknown until there are 5 of the ad's own users and 20 others to compare with. "Staying" means seen again after the app's rhythm (7, 14 or 30 days for daily, weekly, monthly apps). If everyone leaves, no ad is blamed.
- **The retention engine knows who came from ads.** Its snapshot splits new users into ad-brought and everyone else. When ad-brought new users come back clearly less (under 70% of the others' rate, 20+ of each), the gap is the first minutes after the ad, not the ad: day2 tickets one treatment — "continue the ad's promise" — for ad-brought users only (the app reads `day2.cameFrom()` from the field library), measured against its own holdout of ad-brought users.
- **While ads buy users, new users' leak weighs 1.5×** when the retention engine picks what to fix next.
- **Don't pour into a leaking bucket.** While fewer than 10% of new users come back the next period (30+ new users), ads keep running but don't scale up; they scale again by themselves once the retention engine has lifted it. The Ads tab says so and links to Retention.

The console shows all of this under **Growth → Ads**:
- this month's credits, people brought, and credits per sign-up (and a note when scale-ups are on hold);
- platforms: through whose account, the page ads show as, sign-ups sent back, and one button for whatever is missing;
- every campaign with its spend, people, sign-ups, fit ("stay vs. others") and cost per one — and each ad's own results (best, paused and why);
- what day2 learned;
- the ads that were made.

**Privacy.** The visitor's IP and browser are captured only on web visits that came from an ad click, only to send that conversion, and removed after 7 days (`field-store` prune). The click id stays with the visit. Mobile apps send no click id at all unless the owner turns on ad conversions, and then only after the user agrees (App Tracking Transparency on iOS) — see `docs/store-privacy.md` for that and for the App Store / Google Play answers.

## Platforms

Each adapter in `src/ads/platforms/<id>.ts` talks to the platform's official API directly. There is no agent in the loop where money moves. Ad accounts may bill in any currency.

Older setups can still put day2's account in the environment (below); connecting on the Platform page replaces that.

| Platform | API | Ads | Identity | Server environment |
|---|---|---|---|---|
| Meta | Graph / Marketing API v26 | video, image | the app's Facebook Page (and optionally Instagram account), assigned to day2's system user | `META_ACCESS_TOKEN`, `DAY2_META_AD_ACCOUNT_ID`, optional `META_APP_SECRET`, `DAY2_META_DSA_PAYOR` |
| TikTok | TikTok API for Business v1.3 | video | made by day2 from the app's name and logo | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID` |
| Google | Google Ads API v26 (REST) | search (text), Demand Gen (images) | none (business name = the app) | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| LinkedIn | Marketing API 202610 | image or video (one kind per campaign) | the app's company page (`urn:li:organization:…`), with day2's member as Sponsored Content Poster | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REFRESH_TOKEN`, `LINKEDIN_AD_ACCOUNT_ID` |
| Snapchat | Marketing API v1 | video, image (9:16) | the app's Public Profile, shared with day2's organization | `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET`, `SNAP_REFRESH_TOKEN`, `SNAP_AD_ACCOUNT_ID` |
| Pinterest | API v5 | image, video pins | none (ads show day2's business profile; the creative carries the app's brand) | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`, `PINTEREST_REFRESH_TOKEN`, `PINTEREST_AD_ACCOUNT_ID`, optional `PINTEREST_BOARD_ID` |
| Reddit | Ads API v3 | image, video (fetched from day2's URL) | the app's Reddit profile (`t2_…`), linked to day2's ad account | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_REFRESH_TOKEN`, `REDDIT_AD_ACCOUNT_ID`, `REDDIT_USER_AGENT`, optional `REDDIT_FUNDING_INSTRUMENT_ID` (the account also needs a pixel) |
| X | Ads API v12 | video, image | the app's X account, as a promotable user of day2's ads account | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_ADS_ACCOUNT_ID`, optional `X_FUNDING_INSTRUMENT_ID` |

- **Not connected:** a platform without its environment variables is not connected and is skipped.
- **Switching one off:** `DAY2_ADS_DISABLE=reddit,x` switches platforms off without removing their keys.
- **Rotating refresh tokens:** some platforms (Pinterest, LinkedIn) issue a new refresh token on each refresh. day2 keeps the newest one encrypted in `.day2-ads-tokens.json` on its disk, so it needs `DAY2_SECRETS_KEY`.

**Platform caveats.**
- **Google:** conversions go through the Data Manager API (Google closed offline conversion uploads to new projects in June 2026), falling back to `uploadClickConversions` for allowlisted projects. Enable the Data Manager API in the Cloud project.
- **X:** only the full owner of an X ads account can post promoted-only posts as an app's account, so an app that wants X needs its own X ads account.
- **Snapchat, Reddit:** day2 can find an existing pixel but not create one; without one, conversions aren't sent there.
- **Snapchat, Pinterest:** conversions need the visitor's IP and browser together.

**Identities.** Ads always appear under an account. Platforms marked "the app's …" need it linked once:
- The owner or an admin connects it on **Growth → Ads** (or links it by id via `PUT /api/apps/:id/growth/ads/identities/:platform`).
- Until then day2 runs the app on the platforms that are ready, and the console says what's missing.
- Meta Pages assigned on the Platform page count automatically.

**Video providers** (`src/ads/providers/`):
- Creatify: `CREATIFY_API_ID`, `CREATIFY_API_KEY`, optional `CREATIFY_USD_PER_CREDIT` (default $0.198, the Starter API plan), `CREATIFY_AVATAR_ID`, `CREATIFY_VOICE_ID`.
- Runway: `RUNWAYML_API_SECRET` and `DAY2_ADS_RUNWAY=on`.

The server image includes ffmpeg and Chromium.

## What's verified, and what isn't

- **Unit-tested, not live-tested:** every adapter was written against the platform's current documentation and tested call by call against that documentation. None has run against a live ad account yet. Before relying on a platform, launch one small campaign on it from a test app; each adapter's header comment lists the points its docs left open.
- **Media by URL:** platforms that fetch media by URL need day2's public address (`DAY2_PUBLIC_URL`) to be reachable from the internet. On a laptop it isn't, so those launches fail there.
- **AI disclosure:**
  - Ads that show an AI presenter say so in their text ("(AI presenter)"). New York requires this disclosure since June 2026, and California from January 2027.
  - TikTok and Snapchat also get their own AI-content label set. Reddit shows no caption under image and video posts, so there the disclosure goes into the headline.
  - Meta, LinkedIn and X have no field for it.
