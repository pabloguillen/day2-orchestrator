# Creator tools

day2 makes posts (docs/social.md) and ad creative (docs/ads.md) from the
app's real screens and Brand DNA. Built in and always available: images of
the app on a phone, walkthrough recordings, and Motion videos. Creator tools
are optional outside services that add more kinds of media:

| Tool | Makes | Used for |
|---|---|---|
| Runway | generated video clips | the app's real screen comes alive (b-roll posts, generated ad shots) |
| Luma (Ray) | generated video clips | same, alternative model |
| Google (Gemini Omni) | generated video clips | same, with a Gemini API key |
| Creatify | presenter videos | a stock AI presenter reads the script (talking-head posts and ads) |
| HeyGen | presenter videos | same, HeyGen's stock studio avatars, with captions |
| ElevenLabs | voiceovers, music | voiceover for generated clips in the post's language; instrumental music when there's no voice tool |
| OpenAI Images | still images | background scenes behind the real app screen in image posts |

Code: `src/creative/` (catalog, providers, selection, the kit, routes, the key
store), migration `027_creator_tools.sql`.

## For owners: Growth → Accounts → Creator tools

One row per tool: what it does in one line and where it stands.

- **Use day2's** — when the server's operator has an account with the tool.
  day2 runs it on its account and bills what it costs in credits, like any
  other generation. The row shows about how many credits one video, clip or
  image costs before you switch it on, and how many were used this month.
- **Connect your own** — paste your API key for the tool. day2 checks it with
  one cheap call that makes nothing (for example HeyGen's avatar list or
  ElevenLabs' account), then stores it encrypted. It is never shown again,
  not even in part. Your own account means no credits for that tool: the row
  says "billed by HeyGen". A key can be for this app or for the whole
  workspace (all your apps); an app's own key wins.
- **Off** — never used for this app.

Per app and tool there are two switches — **Posts** and **Ads** may use it —
and a **monthly cap in credits** for day2's account (default 300). When the
next video would go over the cap, day2 uses another tool or a built-in
format instead. Your own account isn't capped by day2.

Every post card says what made it ("Made with Runway"), and whether it was
your account or day2's.

### Faces and voices

Presenter tools use the tool's **stock avatars** and voices only. You can
enter your own avatar ID (HeyGen digital twin, Creatify avatar) or a cloned
voice ID (HeyGen, ElevenLabs) only with the consent box: it must be you, or
someone who agreed in writing. day2 records who confirmed it and when.
Generated clips and images never show people: every prompt day2 sends ends
with "no people, no faces, no added text, captions, logos or brand names",
and prompts with @handles, web addresses, emails or asks for a famous
person's likeness or style are never sent. The tools' own content policies
apply on top; a clip a tool refuses is dropped and the built-in format is
used. Captions and scripts still go through day2's content safety check and
its claims and authenticity checks before anything is generated.

## In designed posts (creative-quality.md)

The studio's templates use creator tools as inputs, not as the design:
ElevenLabs makes the **music bed** under motion videos (when Posts may use
it; else day2's built-in beat), and generated clips (Runway, Luma, Google)
or the owner's uploaded clips are the **b-roll** of POV posts. The real
screens, type and layout always come from day2's templates.

## How day2 picks a tool

1. **The format** is picked first, as before, by the growth allocator from
   this app's results: Motion video, walkthrough, presenter video, generated
   clip with a voiceover (new: `generated-broll-short-video`), or still
   image. Presenter videos are only possible with a presenter tool, generated
   clips only with a video tool.
2. **Which tool** makes it: from the tools that can make it in that format,
   that Posts/Ads may use, that have an account (yours or day2's), and —
   on day2's account — whose estimate fits the rest of the month's cap.
   Before any results: your own account first (already paid for), then the
   cheapest. With results, the allocator decides per `<format>@<tool>` (for
   example `generated-broll-short-video@runway` vs `…@luma`): post
   engagement feeds it at 72 hours, ad results as they come in. So day2
   learns which tool works for which kind of post.
3. **What it makes:**
   - presenter video: the writer's ≤ 75-word narrator script (never a
     customer, never a testimonial);
   - generated clip: the app's real screen in its branded phone frame is the
     first frame; the tool only adds motion and light (the writer's `scene`,
     plus Brand DNA's colours and imagery). A voiceover of ≤ 20 words from
     the voice tool, else instrumental music, else silence;
   - still image: a generated background scene in the brand's colours; the
     real app screen and headline go on top.
4. **Falls back** to the built-in formats when no tool fits, a tool fails or
   the cap is reached.

Media is fitted to each platform's spec afterwards (9:16 H.264/AAC 1080×1920
for Reels and TikTok, 4:5 feed images; for ads, every ratio the platforms
need), whatever the tool made.

## Costs and credits

- **Caps hold per job.** Before every job on day2's account, its estimate is
  reserved against the tool's monthly cap from the app's settings as they
  are at that moment (under a lock on `day2-creator-tools.json`, so the
  social and ads passes can't both squeeze in), then settled to the real
  cost when it's done (HeyGen's real duration, Luma's `credits_charged`), or
  released if it fails. A real cost above the estimate can take the month a
  little over the cap; the next job is then refused.
- **Billed right away.** With day2's account, the customer's credits are
  checked for the estimate before the job runs, and the job is charged as
  soon as it finishes — once (charge id `creator:<app>:<tool>:<job>`), even
  if a later step of the post or ad fails.

- day2's account: the tool's cost (from its own answer where it reports one,
  else the estimate below) goes on the credits ledger as
  `content_generation` with day2's usual markup, and counts against the
  tool's monthly cap. An estimate in credits is shown on the tool's row.
- Your own account: 0 credits; the tool bills you.

| Tool | Estimate day2 uses | Source (Nov 2026) |
|---|---|---|
| Runway | 12 credits/s (gen4.5) × $0.01 | docs.dev.runwayml.com pricing |
| Creatify | 5 credits per started 30 s × $0.198 | docs.creatify.ai billing |
| HeyGen | $0.99/min (Avatar III), $4.83/min (Avatar IV) | help.heygen.com API pricing |
| Luma | 100 credits per 5 s at 720p × `LUMA_USD_PER_CREDIT` (default $0.01, an assumption) | docs.agents.lumalabs.ai pricing |
| Google | ≈ $0.10 per second at 720p | Gemini API pricing (5,792 tokens/s × $17.50 / 1M) |
| ElevenLabs | $0.08 per 1,000 characters; music $0.15/min | elevenlabs.io/pricing/api |
| OpenAI Images | token usage from the answer, else $0.06 per image | OpenAI API pricing |

Each estimate can be set per server (env below) when a plan differs.

## For operators: day2's own accounts

Set the keys in `.env` (docs/deploying.md §7, docs/operator-setup.md step 6)
and restart. The Platform page lists each tool as connected or missing.
Runway and Creatify stay on by default for every app (as before); the other
tools are offered and an owner turns them on with "Use day2's".

| Tool | Required | Optional |
|---|---|---|
| Runway | `RUNWAYML_API_SECRET`, `DAY2_ADS_RUNWAY=on` | `RUNWAY_MODEL`, `RUNWAY_USD_PER_CREDIT` |
| Creatify | `CREATIFY_API_ID`, `CREATIFY_API_KEY` | `CREATIFY_USD_PER_CREDIT`, `CREATIFY_AVATAR_ID`, `CREATIFY_VOICE_ID`, `CREATIFY_SCRIPT_STYLE`, `CREATIFY_VISUAL_STYLE` |
| HeyGen | `HEYGEN_API_KEY` | `HEYGEN_AVATAR_ID` (a stock look), `HEYGEN_VOICE_ID`, `HEYGEN_ENGINE` (`avatar_iii` default, `avatar_iv`), `HEYGEN_USD_PER_SECOND` |
| Luma | `LUMA_API_KEY` | `LUMA_MODEL` (`ray-3.2`), `LUMA_RESOLUTION` (`540p`/`720p`/`1080p`), `LUMA_USD_PER_CREDIT` |
| Google | `GEMINI_API_KEY` | `GEMINI_VIDEO_MODEL` (`gemini-omni-1.1-flash`), `GEMINI_VIDEO_USD_PER_SECOND` |
| ElevenLabs | `ELEVENLABS_API_KEY` | `ELEVENLABS_VOICE_ID` (premade), `ELEVENLABS_MODEL`, `ELEVENLABS_USD_PER_1K_CHARS`, `ELEVENLABS_USD_PER_MUSIC_MINUTE` |
| OpenAI Images | `OPENAI_API_KEY` | `OPENAI_IMAGE_MODEL` (`gpt-image-2`), `OPENAI_IMAGE_QUALITY` (`medium`), `OPENAI_IMAGE_USD_PER_IMAGE` |

Owners' keys need `DAY2_SECRETS_KEY` (they're encrypted with it, bound to
their row).

What day2's own account sends to a tool: the script or prompt, and for
generated clips the app's screen in day2's frame. These providers are listed
in the privacy policy (site/privacy.html) as processors. With the owner's
own account, the tool is the owner's provider.

## API

All under `/api/apps/:id/creator-tools`, scoped to the signed-in account's
app; changes need an owner or admin. Keys are never returned.

| | |
|---|---|
| `GET /creator-tools` | every tool: what it makes, day2's account (and the estimate), your own (scope, who, when, consent), switches, cap, use this month |
| `PUT /creator-tools/:tool` | `account` (`auto`, `day2`, `own`, `off`), `posts`, `ads`, `capCredits` |
| `POST /creator-tools/:tool/key` | `fields` (the tool's key fields), `scope` (`app` or `workspace`), `consent` (needed for your own avatar/voice) — checked, then stored |
| `DELETE /creator-tools/:tool/key?scope=app\|workspace` | disconnect your own account |

`GET /social` posts carry `madeWith: [{tool, name, capability, account}]`.

## Downloads, keys and prompts

- **Downloads.** What a tool returns as a link is fetched only over https,
  from the tool's known hosts (`src/creative/download.ts` KNOWN_HOSTS: e.g.
  HeyGen `heygen.ai`/`heygen.com`, Runway `runwayml.com`, Luma
  `lumalabs.ai`/`cdn-luma.com`, plus the CloudFront/S3 domains they serve
  signed links from), when every address it resolves to is public (no
  loopback, private, link-local/metadata, CGNAT or multicast). Redirects
  are followed by hand, at most 3, each checked again. 5-minute timeout;
  size cap while streaming (video 200 MB, image 20 MB, audio 50 MB); the
  content type must match. The host lists are from the docs and not yet
  confirmed against real accounts: an unknown host is refused with an
  error naming `DAY2_CREATOR_HOSTS_<TOOL>` (comma-separated host suffixes)
  to add it. The address check happens before the request (the fetch
  resolves again; a DNS change in between isn't caught).
- **Keys** are encrypted bound to the row, the account, the app (or the
  workspace) and the tool: a copied ciphertext won't decrypt anywhere else.
- **Prompts** (scripts, voiceover text, scene prompts) are refused if they
  contain any web address or shortener, an @handle, an email, or the name of
  a well-known person. Scene prompts (generated clips, images) are also
  refused when they ask for a person ("actor", "influencer", "famous", "in
  the style of", …) or seem to name one (two capitalised words in a row
  mid-sentence; the app's own name is allowed), and always end with "no real
  or recognizable people". The owner's Brand DNA imagery goes into scene
  prompts marked as a description, not instructions.

## API calls and what's unverified

Every tool is built from its public API documentation (links in
`src/creative/providers/*` and `src/creative/catalog.ts`) and tested against
fakes (`src/creative/*.test.ts`). **None has been run against a real account
yet.** Particular points to check on the first real run:

- **HeyGen** — v3 (`POST /v3/videos`, `GET /v3/videos/{id}`,
  `GET /v3/avatars/looks?ownership=public`); v1/v2 were sunset on 31 Oct
  2026. Whether the stock avatar's default voice reads German well with
  `voice_settings.locale`.
- **ElevenLabs** — `POST /v1/text-to-speech/{voice}`, `POST /v1/music`,
  `GET /v1/user`. The default premade voice id (`21m00Tcm4TlvDq8ikWAM`) is
  from ElevenLabs' library and may change.
- **Google** — Veo 3.1 preview models were shut down on the Gemini API on
  22 Oct 2026 and GA Veo is only on Google Cloud's Gemini Enterprise Agent
  Platform (service accounts, not an API key). day2 therefore uses Gemini
  Omni Flash through `POST /v1beta/interactions` (one synchronous call, the
  video comes back inline). Google's docs described `gemini-omni-1.1-flash`
  while mentioning newer versions; set `GEMINI_VIDEO_MODEL` if that changes.
- **Luma** — the Agents API (`https://agents.lumalabs.ai/v1/generations`,
  `ray-3.2`), not the older Dream Machine v1 API. The start frame is sent as
  `{data: <base64>}`; the USD value of a Luma credit is an assumption.
- **OpenAI Images** — `POST /v1/images/generations`, `gpt-image-2`
  (`gpt-image-1` was shut down on 23 Oct 2026); key check `GET /v1/models`.
- **Runway** — the key check `GET /v1/organization` is from the API
  reference's endpoint list (generation itself was checked against the SDK).
- **Creatify** — key check `GET /api/personas/`.

## Not added

- **Kling** — its official API docs (kling.ai/document-api) only render as
  an app that couldn't be read and checked, and auth is a self-signed JWT
  from an access key / secret key pair. The packages found are unofficial.
  Not built until the official reference can be verified.
- **Ideogram** — the v1 generate endpoint is marked legacy in favour of
  `POST /v2/image/generate/ideogram-3`, whose reference couldn't be read.
  OpenAI Images covers still images for now.
- **Google Veo on the Gemini API** — shut down (see above); Google's video
  comes through Gemini Omni instead.
