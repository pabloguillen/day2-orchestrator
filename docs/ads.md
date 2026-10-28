# Ads on every platform

day2 runs an app's paid ads by itself:
- It makes the ads (images, videos, text).
- It launches them on every platform it can.
- It reads the results.
- It moves the money to what works.

Ads run from **day2's own ad account on each platform**. The spend is billed to the customer's credits at the paid-ads markup (`credits.ts`). Customers never see day2's own costs; the console and the autopilot log show credits only.

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
   - **AI presenter videos (Creatify).** Made when Creatify is connected and the script passed both checks.
   - **Generated motion shots (Runway).** Off by default; switch on with `DAY2_ADS_RUNWAY=on`.

   Generated video is capped at $12 per experiment (before markup) and billed as content generation. Files are kept on day2's disk and served at `/api/assets/<unguessable id>`, because most platforms fetch media by URL.
5. **Launch.**
   - Each platform gets the ads that fit its formats: videos where it takes them, else images. Google runs search ads built from the keywords.
   - Each platform gets its own tracked link (`?d2=B-4.tiktok`). That lets day2 see in its own usage events who came from where, measured the same way on every platform.
   - Campaigns are created paused and switched on only once every part exists. If a launch fails halfway, what was created is removed.
6. **Every pass after that.** Results are read every 6 hours.
   - **Billing:** spend is billed in credits as it's reported, and never twice.
   - **Rejected:** a rejected ad is stopped on that platform, and the platform's reason is logged.
   - **Broken page:** its ads are held until the page works again (field checks).
   - **Budget used:** when the month's ad budget is used, everything is held until the new month.
   - **Comparing platforms**, per experiment, after 3 days and enough spend, by credits per sign-up (or per user reaching first value):
     - a platform that spent without a single result is stopped;
     - one that costs more than 2.5× the best is cut to its minimum, or stopped if it's already there;
     - the best gets 1.5× more, at most weekly.
   - **Worse overall:** an experiment that brings people who do worse than everyone else is stopped everywhere.
7. **Kill switch.** The kill switch, or turning the autopilot off, pauses every ad on every platform.

The console shows all of this under **Growth → Ads**:
- this month's credits;
- platforms (running, ready, needs linking, not connected);
- every campaign with its credits, people, sign-ups and credits per sign-up;
- the ads that were made.

## Platforms

Each adapter in `src/ads/platforms/<id>.ts` talks to the platform's official API directly. There is no agent in the loop where money moves. Every ad account must bill in **USD**; launches refuse anything else.

| Platform | API | Ads | Identity | Server environment |
|---|---|---|---|---|
| Meta | Graph / Marketing API v26 | video, image | the app's Facebook Page (and optionally Instagram account), assigned to day2's system user | `META_ACCESS_TOKEN`, `DAY2_META_AD_ACCOUNT_ID`, optional `META_APP_SECRET`, `DAY2_META_DSA_PAYOR` |
| TikTok | TikTok API for Business v1.3 | video | made by day2 from the app's name and logo | `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID` |
| Google | Google Ads API v26 (REST) | search (text), Demand Gen (images) | none (business name = the app) | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| LinkedIn | Marketing API 202610 | image or video (one kind per campaign) | the app's company page (`urn:li:organization:…`), with day2's member as Sponsored Content Poster | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REFRESH_TOKEN`, `LINKEDIN_AD_ACCOUNT_ID` |
| Snapchat | Marketing API v1 | video, image (9:16) | the app's Public Profile, shared with day2's organization | `SNAP_CLIENT_ID`, `SNAP_CLIENT_SECRET`, `SNAP_REFRESH_TOKEN`, `SNAP_AD_ACCOUNT_ID` |
| Pinterest | API v5 | image, video pins | none (ads show day2's business profile; the creative carries the app's brand) | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`, `PINTEREST_REFRESH_TOKEN`, `PINTEREST_AD_ACCOUNT_ID`, optional `PINTEREST_BOARD_ID` |
| Reddit | Ads API v3 | image, video | see `platforms/reddit.ts` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_REFRESH_TOKEN`, `REDDIT_AD_ACCOUNT_ID` |
| X | Ads API v12 | video, image | the app's X account, as a promotable user of day2's ads account | `X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_ADS_ACCOUNT_ID`, optional `X_FUNDING_INSTRUMENT_ID` |

- **Not connected:** a platform without its environment variables is not connected and is skipped.
- **Switching one off:** `DAY2_ADS_DISABLE=reddit,x` switches platforms off without removing their keys.
- **Rotating refresh tokens:** some platforms (Pinterest, LinkedIn) issue a new refresh token on each refresh. day2 keeps the newest one encrypted in `.day2-ads-tokens.json` on its disk, so it needs `DAY2_SECRETS_KEY`.

**Identities.** Ads always appear under an account. Platforms marked "the app's …" need it linked once:
- The owner, an admin or day2's operator links it on **Growth → Ads** (or via `PUT /api/apps/:id/growth/ads/identities/:platform`).
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
  - TikTok and Snapchat also get their own AI-content label set.
  - Meta, LinkedIn and X have no field for it.
