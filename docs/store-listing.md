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
- Agents (paid from your credits): search terms and listing texts
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

## Where the data is

- Local mode: `day2-store-listing.json` (settings, listings, proposals,
  research, screenshot sets, tests, pages, ratings, log) and
  `day2-store-reviews.json` in the app's folder; framed screenshots in
  day2's data folder under `store-screens/`.
- Accounts mode: Postgres tables `store_listing` and `store_reviews`
  (migration `013_store_listing.sql`).

Reviews are public, but day2 still keeps reviewers' nicknames out of tickets
and events, and keeps reviews for a year.
