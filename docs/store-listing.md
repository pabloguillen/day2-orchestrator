# Store: the App Store and Google Play listing

day2 looks after how people find and judge the app in the stores: the
listing texts in every language, keywords, screenshots, Apple's product page
tests and custom product pages, and ratings and reviews. It all lives on the
app's **Store** page in the console. Code: `src/store-listing/`.

## What day2 does

| | What day2 does | What you approve (default: "Ask me first") |
|---|---|---|
| Listing texts | Reads the listing from both stores once a day. Every 30 days and after each new store version, it researches the App Store (real search results and competing apps) and proposes better texts with before/after, character counts and a reason. | Each change. You can edit the text before approving. |
| Screenshots | Runs the app on your Mac's iPhone Simulator and Android emulator, captures the key screens in every language, and frames them with captions in the app's colors at the sizes the stores need. | Each set of screenshots. |
| Tests | App Store product page tests (screenshot variants against the current page) and custom product pages for ad campaigns. Google Play experiments with a "Do it with me" walkthrough. | Each test and each page. You enter the result (see below). |
| Reviews | Reads new reviews every 6 hours, drafts replies in the app's voice, and turns 1–2 star reviews that describe a problem into backlog tickets. More reviews of the same problem raise the same ticket's count instead of adding tickets. | Each reply, unless you choose "4–5 stars go out by themselves". |
| Store setup | Fills out App Store Connect and Google Play: links, contact, categories, age rating, App Review information, price and countries, Play details and graphics, app previews. Prepares the answers for the forms with no API. See "Store setup" below. | Each fact once; graphics like screenshots. |
| Rating prompt | Decides when the app asks for a rating (after which events, how often, never right after a problem). The rule reaches the app over the air in the Live config (`review`). | The rule, on the Store page → Settings. |

Choose **day2 decides** (Store → Settings) to let texts, screenshots and tests
go out without asking. Everything day2 does is in the page's log.

### How a change reaches the store

- **Promotional text** (App Store): live right away, no review needed.
- **Name, subtitle, keywords, description** (App Store): these can only change
  with a new App Store version. Approved changes wait and go into the next
  version day2 submits (the release flow writes them in just before it sends
  the version to review), or into a version you're preparing in App Store
  Connect, if there is one.
- **Google Play texts and screenshots**: one edit with all approved changes,
  committed at once. If a release is in review, Google refuses the edit and
  day2 tries again in its next pass.
- **App Store screenshots**: with the next version, like the texts.

### Limits day2 checks

App Store: name 30, subtitle 30, keywords 100 **bytes** (an umlaut counts
two), comma-separated without spaces, promotional text 170, description 4000.
Google Play: title 30, short description 80, full description 4000.

### Screenshots

The first time, day2 adds a ticket for the build agent: a Maestro flow,
`.maestro/day2/store-screens.yaml`, that walks to the app's key screens and
takes a screenshot of each (with demo data, never a real person's), plus
`.maestro/day2/store-screens.json`, which says what each screen shows. day2
runs it once per language (`-e DAY2_LOCALE=de-DE`, `DAY2_LOCALE_LANG=de`,
`APP_ID=…`) and writes the captions itself.

Sizes: iPhone 6.9" 1320×2868 and 6.5" 1284×2778 (portrait), iPad 13"
2064×2752 only when you turn on tablets, Android phone 1080×1920. This needs a
Mac with Xcode (and Android Studio for Android screenshots) and Maestro —
local mode only. A deployed day2 can't run simulators yet.

### Ads and custom product pages

A custom product page made for a campaign or experiment (e.g. `B-4`) gets its
own App Store address with `?ppid=…`. Once Apple approves it, day2's smart
link sends iPhone users from that campaign's ads to that page.

## Store setup: day2 fills out the stores

The **Setup** tab on the Store page lists everything App Store Connect and
Google Play need before the first review, per store, and keeps it in sync
afterwards. Each item is one of:

- **Done** — in the store (written by day2 through the API, or read back);
- **Waiting for your OK** — day2 prepared it from the app's code;
- **Your step** — Apple or Google have no API for it: day2 prepared the exact
  answers (each with a copy button) and a **Do it with me** walkthrough; you
  click **Done**;
- **day2 is on it** — approved, and goes in with the next pass or the next
  App Store version;
- **Not needed** — optional (a promo video, previews on a server without a Mac).

### Who decides what

| | How it's decided | After that |
|---|---|---|
| Texts (name, subtitle, description, keywords, promotional text, what's new, Play listing) | Listing proposals, the Store module's approval setting (default: you approve each) | Research every 30 days |
| Graphics (Play icon and feature graphic, App Store previews) | The same setting as screenshots | Made again only when you discard them |
| Facts (links, contact, categories, content rights, age rating, App Review contact, price and countries) | Proposed **once**, approved **once** (you can edit before approving) | day2 writes them and puts them back if the store drifts from what you approved |
| Submitting for review | The release flow's existing rules | Unchanged — setup never submits anything |

The setup pass runs with the Store pass (growth autopilot): the first time,
then every 6 hours, and right after you approve something. It reads first and
writes only what differs, so a pass where everything matches changes
nothing. Everything it writes is in the page's log. **Check again** runs it now.

The answers come from one agent run over the app's code (Read/Grep/Glob, at
most $0.80, from your credits, after the app scan). Without the scan, the
proposals start empty for you to fill in.

### App Store Connect (through the API)

| Item | API |
|---|---|
| Categories | `PATCH /v1/appInfos/{id}` relationships `primaryCategory` / `secondaryCategory` (`appCategories` ids like `FINANCE`) |
| Content rights | `PATCH /v1/apps/{id}` `contentRightsDeclaration` (`DOES_NOT_USE_THIRD_PARTY_CONTENT` / `USES_THIRD_PARTY_CONTENT`) |
| Privacy policy and privacy choices links | `PATCH /v1/appInfoLocalizations/{id}` `privacyPolicyUrl`, `privacyChoicesUrl`, every language |
| Name, subtitle, description, keywords, promotional text, what's new | The listing (see above) |
| Support link, marketing link, copyright | `appStoreVersionLocalizations` `supportUrl`, `marketingUrl`; `appStoreVersions` `copyright` — on a version being prepared, else just before the release flow submits the next one |
| Age rating | `GET /v1/appInfos/{id}/ageRatingDeclaration`, `PATCH /v1/ageRatingDeclarations/{id}` with Apple's current questionnaire: the frequency questions (`violenceCartoonOrFantasy` … `contests`: `NONE`, `INFREQUENT_OR_MILD`, `FREQUENT_OR_INTENSE`), the yes/no ones including the 2025 additions (`messagingAndChat`, `userGeneratedContent`, `advertising`, `healthOrWellnessTopics`, `parentalControls`, `ageAssurance`, `unrestrictedWebAccess`, `gambling`, `lootBox`) and `ageRatingOverrideV2: NONE`. day2 reads it back after writing; answers Apple didn't take become **your step** with the answer to pick |
| App Review information | `appStoreReviewDetails` (one per version): contact name, phone, email, notes, `demoAccountRequired`, and the demo account |
| Price and countries | `appPriceSchedules` (one manual price in the base territory from today; the price point found in `/v1/apps/{id}/appPricePoints`), `/v2/appAvailabilities` with inline `territoryAvailabilities` the first time, `PATCH /v1/territoryAvailabilities/{id}` after |
| App icon | Comes from the build. day2 checks the app config's icon instead (1024×1024 PNG, no alpha channel) and adds a ticket when it's wrong |
| Screenshots | Checks the version's `appScreenshotSets`: an iPhone set (6.9" or 6.5") and the 13" iPad when `ios.supportsTablet` is on |
| App previews | `appPreviewSets` (`previewType` `IPHONE_67`, `IPHONE_65`) → `appPreviews` (reserve with `fileName`, `fileSize`, `mimeType`, `previewFrameTimeCode`; upload Apple's parts; commit with `uploaded` and the MD5) — with the next version |
| Build | The release flow attaches it; setup reads it back |
| Export compliance | The release flow (no non-exempt encryption per build), or the app config's `usesNonExemptEncryption` |
| App Privacy | No API: the Privacy page (store-privacy.md) |

**The demo account** is entered on the App Review item. day2 stores it
encrypted with `DAY2_SECRETS_KEY` (AES-256-GCM, bound to the app), never
returns it through the API or shows it in the console, and decrypts it only
to write it into App Store Connect.

### App previews (video)

On a Mac in local mode, day2 records one preview per language: the app is
built and installed on the iPhone Simulator, `xcrun simctl io <udid>
recordVideo --codec=h264` records the screen while the app's flow runs
(`.maestro/day2/store-preview.yaml` if it has one, else the screenshot flow),
then **ffmpeg** trims it to 15–30 seconds (skipping the launch second) and
encodes it to Apple's spec: H.264 High profile level 4.0, 10–12 Mbps, 30 fps,
886×1920 portrait (taken by both iPhone sizes), with a silent stereo AAC
track at 256 kbps. Install ffmpeg with `brew install ffmpeg`. A flow that
runs under 15 seconds gives a plain message to make it longer. iPad previews
aren't made (they'd need an iPad recording).

### Google Play (through the API)

| Item | API |
|---|---|
| Title, short and full description | The listing (see above) |
| Contact email, phone, website, default language | `edits.details` (get, patch), committed |
| Hi-res icon (512×512 PNG) and feature graphic (1024×500 JPEG, no alpha) | Made from the app icon, the app's name and its promise in the brand's colors, rendered by Chromium with every web request blocked; `edits.images` (deleteall, upload) per language |
| Phone, 7" and 10" tablet screenshots | The screenshots (tablets when **Tablet screenshots** is on, Store → Settings): `phoneScreenshots`, `sevenInchScreenshots` (1080×1920), `tenInchScreenshots` (1440×2560) |
| Promo video (YouTube) | `edits.listings.patch` `video`, every language. Optional |
| Release notes per track | The release flow writes them; setup reads `edits.tracks.list` back |

### Guided steps (no API)

| Item | Where | What day2 prepares |
|---|---|---|
| App Privacy (Apple) | App Store Connect → App Privacy | The Privacy page's answers and walkthrough |
| Data safety (Google) | App content → Data safety | The Privacy page's answers, step by step (see below) |
| Content rating (IARC) | App content → Content rating | Category, then violence, sexual content, language, substances, fear, gambling, user interaction, location sharing, digital purchases, internet access — from the age rating answers |
| Target audience and content | App content | Age groups, appeal to children |
| Ads | App content | Contains ads (from Money's AdMob ticket or the code) |
| App access | App content | Restricted or not; reviewers use the same demo account (you type it in) |
| News, health, financial, government | App content | Yes/no for each |
| Category and tags | Store settings | Google Play has no API for them (`AppDetails` has no category) |

day2 can't read these back. Your **Done** is kept for the answers you saw; when
day2's answers change (the app gained chat, ads, purchases…), the step comes
back as **your step**.

**Data safety CSV.** The Play Console imports and exports the Data safety form
as CSV (columns `Question ID (machine readable)`, `Response (machine
readable)`, `Response value`, `Answer requirement`, `Human-friendly question
label`), and the Android Publisher API has `applications.dataSafety` that
takes the same CSV. The question ids we could check (`PSL_DATA_TYPES_*`,
`PSL_DATA_USAGE_RESPONSES:<type>:…`, the purposes) aren't the full template —
the per-data-type ids for app activity and app performance couldn't be
verified — so day2 doesn't generate the CSV yet and uses step-by-step answers.

## APIs day2 uses

All with the accounts you connected for releases (Releases page): the App
Store Connect API key (App Manager role) and the Google Play service account.
No new accounts.

- App Store Connect: `appInfos` / `appInfoLocalizations`, `appStoreVersions` /
  `appStoreVersionLocalizations`, `appScreenshotSets` / `appScreenshots`
  (reserve, upload the parts, commit with MD5), `v2/appStoreVersionExperiments`
  with `appStoreVersionExperimentTreatments` and their localizations,
  `appCustomProductPages` (version and localization created in the same
  request), `reviewSubmissions`, `customerReviews` and `customerReviewResponses`.
- Google Play Developer API v3: `edits` → `listings`, `images`
  (`phoneScreenshots`), `validate`, `commit`; `reviews.list`, `reviews.reply`.
- The public iTunes Search API (`/search`, `/lookup`) for keywords,
  competitors and the public rating. Competitors' subtitles come from their
  public App Store pages, when the page has one.
- Store setup: the App Store Connect and Google Play calls in "Store setup"
  above.
- Agents (paid from your credits): store setup answers (`agent_work`, once),
  search terms and listing texts
  (`agent_work`, `content_generation`), review replies and screenshot
  captions (`content_generation`), review problems (`agent_work`).

## Not verified against real accounts

Built from Apple's and Google's documentation and tested with recorded
responses only. Before relying on them, check with the first real account:

- **6.9" iPhone screenshot type**: day2 uploads 1320×2868 screenshots as
  `APP_IPHONE_67`. Apple's docs may now list a separate 6.9" type.
- **Product page tests**: creating treatments on `appStoreVersionExperimentV2`,
  starting with `started: true`, and the experiment states day2 maps
  (`IN_REVIEW`, `RUNNING`, `COMPLETED`, `STOPPED`, …). Apple doesn't offer test
  results through the API, so you enter the winner from App Store Connect.
- **Custom product pages**: submitting a page version through
  `reviewSubmissionItems` (`appCustomProductPageVersion`), and the version
  states treated as live (`ACCEPTED`, `APPROVED`, `READY_FOR_DISTRIBUTION`).
- **Name and subtitle**: written to the app info in `PREPARE_FOR_SUBMISSION`
  (and similar states). If Apple keeps the app info locked, the change stays
  waiting with Apple's message.
- **Reviews**: Apple reviews don't say which version they're about; day2
  assumes the version that was live when the review was written (from its
  own release history). Google Play's API returns only reviews from the last
  week with text.
- **Google Play listing experiments** have no API at all — the walkthrough is
  based on the current Play Console menus, which Google moves around.
- **Locales in screenshots**: launching the app in a language depends on the
  app; the flow ticket asks the build agent to handle `DAY2_LOCALE`.
- **Store setup** (built from Apple's and Google's references, tested with
  recorded responses only):
  - **Age rating's newer questions**: Apple lists `messagingAndChat`,
    `userGeneratedContent`, `advertising`, `healthOrWellnessTopics`,
    `parentalControls`, `ageAssurance` in the API, but developers report some
    can't be set through it yet. day2 reads back after writing; what didn't
    stick becomes your step. Whether Apple prefers `INFREQUENT_OR_MILD` /
    `FREQUENT_OR_INTENSE` or the newer `INFREQUENT` / `FREQUENT` values isn't
    clear from the docs; day2 sends the former.
  - **Price**: `POST /v1/appPriceSchedules` with one manual price and
    `baseTerritory` (a developer reports a bare 409 without it), and the
    current price read through `manualPrices?include=appPricePoint&filter[territory]=…`.
  - **Availability**: the first `POST /v2/appAvailabilities` with inline
    `territoryAvailabilities` (Apple documents it as "create an app
    pre-order"); for an app that has never had availability set.
  - **Privacy links** may only be editable while an app info is being
    prepared; if Apple refuses on the live app info, the item shows Apple's
    message and day2 tries again with the next version.
  - **App previews**: Apple marks `appPreviewSets` / `appPreviews` as
    deprecated in favour of the new App Asset Library and placements. They
    still work per Apple's sample; moving to the asset library is next.
    Whether a silent audio track is needed hasn't been checked with a real
    upload.
  - **Google Play** `edits.details.patch` (fields left out stay as they are),
    `edits.listings.patch` with `video`, and the 7"/10" image types.
  - **IARC questions** follow the questionnaire's current sections; Google
    changes the wording now and then.

## Where the data is

- Local mode: `day2-store-listing.json` (settings, listings, proposals,
  research, screenshot sets, tests, pages, ratings, store setup with the
  encrypted demo account, log) and
  `day2-store-reviews.json` in the app's folder; framed screenshots in
  day2's data folder under `store-screens/`; Play graphics and app previews
  under `store-setup/`.
- Accounts mode: Postgres tables `store_listing` and `store_reviews`
  (migration `013_store_listing.sql`); store setup lives in the same
  `store_listing` document, so no new migration.

Reviews are public, but day2 still keeps reviewers' nicknames out of tickets
and events, and keeps reviews for a year.
