# Numbers

Every app has one **Numbers** page in the console (second in the app menu). It shows installs, people, retention, engagement, money, acquisition, quality and experiments at a glance, in plain language. You pick a period (7, 30 or 90 days, ending today) and every number is compared with the same number of days right before it. The app's Home page shows four of them (new users, monthly active users, revenue, crash-free) with their trends, linking to Numbers.

Code: `src/numbers/` in the orchestrator (`compute.ts` does the arithmetic and is pure; `apple.ts` and `google.ts` read the stores; `fetch.ts` is the store pass; `view.ts` gathers day2's own data; `routes.ts` is the API). Console: `src/routes/apps.$appId.numbers.tsx`, `src/components/numbers-kit.tsx`.

## Rules every number follows

- **Its source is shown** under it: App Store Connect, Google Play Console, day2 field data, ad platforms, payments (checked by day2), store reviews or day2 Live.
- **If day2 can't tell, it says "Not available"** with the reason and the fix, such as "Connect App Store Connect on Releases". It never shows a made-up 0. A day a store hasn't reported yet is missing, not zero.
- **Comparisons show the sample behind them**, for example "+37% vs the period before (n = 410 vs 300)". Counts below 10 and rates or money-per-user below 30 people in either period say **"too few to compare"**. Percentages change in points. A change under 2% (under 0.1 points for small rates) reads "about the same".
- **Store numbers compare the same days.** Apple and Google report 1–2 days late, so the last days of the period are often missing. The period before is counted over the same days (shifted back), and the note says up to which day the store reported.
- Trends are green when they move the good way and amber when they move the bad way. Spend, reviews and experiments are neither.

## What each number means and where it comes from

### Installs and new users

| Number | Meaning | Source | Delay |
|---|---|---|---|
| App Store installs | First-time downloads (App Analytics "App Store Downloads": *First-time Download*, no pre-orders, redownloads, updates or restores). Until App Analytics arrives: app units from Sales and Trends (product types 1, 1-B, 1E, 1EP, 1EU, 1F, 1T, F1, F1-B; redownloads 3/3F and updates 7/7F/7T/F7 excluded; refunds count as −1). | App Store Connect | 1–2 days (Analytics complete after 2 days, Sales the next day) |
| Google Play installs | "Daily User Installs" from the monthly installs overview report (falls back to "Install events", then "Daily Device Installs", in older files). | Google Play Console | 1–2 days |
| Store installs | Both stores together, split by platform. Only when both reported. | stores | as above |
| First opens | Devices seen for the first time on a release with day2's field checks. **Only when the app keeps a fixed device id** (Privacy page); with the default random id per launch every launch looks new, so it's "not available". Split by platform and by source (the day2 ad platform in the first visit's link, or "everyone else"). | day2 field data | live |
| New users | Signed-in people (the app calls `day2.identify`) seen for the first time. Split by platform and source. | day2 field data | live |

### Active users

- **Daily active users**: the average number of signed-in people active per day in the period.
- **Weekly / monthly active users**: people active in the last 7 / 30 days of the period (MAU split by platform).
- **Stickiness**: daily ÷ monthly active users.
- **App Store sessions (iOS)**: sessions from Apple's App Sessions report. These only count people who share data with developers, and only where at least 5 users had the event.

Active users need the app to identify its users. Otherwise the page says so and points to the identify ticket (Growth → Retention).

### Activation and retention

- **Activation rate**: new people (signed-in user, or device when the id is fixed) who sent `activated` within 7 days of their first event. It uses `computeActivationRate` from `src/metrics/activation-engagement-kpis.ts`.
- **Day 1 / 7 / 30 retention**: people whose day *n* falls in the period and who were active on that day (±1 day), using `computeRetention` from `src/metrics/retention-kpis.ts`. Comparing periods works the same way for both.
- **Where people are now** and **the biggest leak**: the lifecycle snapshot from `src/retention.ts` (as of its last computation, not compared).

### Engagement

- **Sessions per user**: app opens (`visit`) per person who opened the app in the period (`computeSessionsPerUser`).
- **Core actions**: the app's own three most common events (not day2's system events), per active person, with "how many did it, how often each" from `computeCoreActionFrequency`.

### Money (apps in the stores)

Revenue, subscriptions, purchases, ad earnings, revenue per user (ARPU, after refunds), per paying user (ARPPU), paying users, trials that became paid (trials started at least 3 days ago) and refunds. All come from `computeKpis` in `src/money/kpis.ts`, so the numbers match the Money page. Revenue is split by platform (Apple → iOS, Google → Android, ad earnings "Ads and other") and by where users came from. The amounts are what users paid, tax included, before the stores' fees, in the app's currency. Sandbox purchases never count. If no payment is connected and day2 has never seen one, the page says so and links to Money.

### Acquisition

- **Ad spend** per period: day2 records each campaign's lifetime spend every day (in the Numbers cache) and subtracts. Before that record reaches back, older spend is spread evenly since launch and marked **estimated**. Ads billed through day2 show in **credits**, as on the Ads page. Ads on the owner's own ad account show in that account's currency, per platform.
- **People from ads**: devices whose first visit came through a day2 ad link (`?d2=B-4.meta.v1`), per ad platform. **Sign-ups** (or "people who got value" when the app has no `signup` event) and **cost per sign-up** follow from that.
- **App Store impressions, product page views, product page conversion** (first-time downloads ÷ product page views): App Analytics "App Store Discovery and Engagement". Impressions add up every engagement type, and page views count only the *Product page* type. Google Play doesn't offer store listing visits for download, so this part is iOS only.

### Quality

- **Crash-free sessions** (or **crash-free users**, counted per day, when the device id is fixed): launches without a crash report, split by platform. Crash reports are kept 30 days. For older days day2 uses the launch and crash counts its daily pass kept.
- **Crash-free by release**: from `releaseHealth` in the field store, for the store builds and updates in `day2-mobile-releases.json` and the latest release reported. Fewer than 30 launches is "too few to judge".
- **Failing checks**: field checks that broke on users' devices in the period, linking to Field checks.
- **Play crash rate / ANR rate**: Android vitals from the Play Developer Reporting API, averaged over the period's days weighted by the users each day. Google's bad-behaviour thresholds are 1.09% (crashes) and 0.47% (ANRs).
- **Store rating**: the latest rating the Store module read, compared with the last reading before the period. **New reviews** counts the reviews written in the period. Both are read through `src/store-listing/store.ts` (Numbers doesn't change Store).

### Experiments

Running experiments (building, waiting or running) and decisions made in the period, from Live.

## How store data gets in

A store pass (`src/numbers/fetch.ts`) reads what the stores have that the cache doesn't:

- **once a day per app**, right after the growth autopilot on the backlog timer (it runs even when the autopilot is off — it only reads);
- when the owner presses **Refresh** (at most every 10 minutes per app; the button says when it can be pressed again).

The cache is `day2-numbers.json` in the app's folder (local mode) or the `numbers_cache` table (accounts mode, migration `018_numbers.sql`). It keeps 400 days. The page reads the cache, never the stores. Computed views are kept for a minute.

Per store:

- **Sales and Trends**: `GET /v1/salesReports` with `frequency DAILY`, `reportType SALES`, `reportSubType SUMMARY`, `version 1_0` (if Apple answers that a newer version is required, day2 retries with the version Apple names). One request per day, up to 180 days back the first time, then only missing days. A 404 for one of the last 3 days means "not published yet" and is asked again; older 404s mean no sales that day (0).
- **App Analytics**: day2 finds or creates the app's `ONGOING` analytics report request, then reads the daily instances of "App Store Downloads Standard", "App Store Discovery and Engagement Standard" and "App Sessions Standard" and their segments (gzip'd, tab-separated). Following Apple's rule, a newer processing date overwrites a day. Values are never added up across instances.
- **Google Play installs**: `gs://pubsite_prod_…/stats/installs/installs_<package>_<yyyymm>_overview.csv` via the Cloud Storage JSON API (`devstorage.read_only`), decoded from UTF-16. The current and last month are read every pass, older months once, 7 months back.
- **Android vitals**: `crashRateMetricSet` and `anrRateMetricSet` (`v1beta1`), first their freshness, then a DAILY query in America/Los_Angeles time (the only time zone the API allows for daily data), with `distinctUsers`.

Every step records whether it worked and, if not, why in plain words. The page shows that next to the number and under **Store reports**.

## What the owner connects

On **Releases** (once per app, already needed for releases):

1. An **App Store Connect API key**. For installs its role must be *Sales and Reports*, *Finance* or *Admin*. App Analytics (impressions, page views, sessions) needs *Admin* once so day2 can start the reports. After that, the reports keep coming.
2. A **Google Play service account** key.

On **Numbers → Store reports**:

3. **Apple vendor number**: App Store Connect → Payments and Financial Reports, top left. Press **Test the connection**: day2 reads a sales report from 4 days ago.
4. **Google Play**: in Play Console → Users and permissions, give the service account **"View app information and download bulk reports"** (installs) and "View app information" (vitals). Turn on the **Google Play Developer Reporting API** in the service account's Google Cloud project. Then go to Play Console → Download reports → Statistics, press **Copy Cloud Storage URI** and paste it. **Test the connection** lists the installs reports for the app's package.

For day2's own numbers: first opens need the **fixed device id** (Privacy), and active users and retention need the app to **identify its users** (day2 adds both with its tickets).

## API

- `GET /api/apps/:id/numbers?days=7|30|90` (default 30): the page, plus `refreshing` and `refreshableAt`.
- `POST /api/apps/:id/numbers/refresh`: starts a store pass (202). Returns 429 within 10 minutes of the last one, 409 while one runs.
- `PUT /api/apps/:id/numbers/settings`: `{ appleVendorNumber?, playBucket? }` (owners and admins; `null` clears).
- `POST /api/apps/:id/numbers/test/apple|google`: `{ ok, message }`.

## Not verified

Built from Apple's and Google's documentation and tested with recorded files and mocked APIs. **Nothing here has been checked against a real App Store Connect or Play account yet.** In particular:

- the Sales and Trends `version` for `SALES/SUMMARY/DAILY` (Apple's table says `1_0`; a 2024 forum thread reported Apple asking for `1_1` for a while, which the retry handles) and whether a 404 for a day just past means "not yet" or "no sales";
- that analytics segment files are tab-separated text in gzip, and the exact `Download Type`, `Event` and `Page Type` spellings (taken from Apple's report pages);
- whether impressions should add up rows across engagement types (day2 does);
- the installs CSV column names in today's files (Google renamed them over the years; day2 takes the first of *Daily User Installs*, *Install events*, *Daily Device Installs*) and the UTF-16 encoding without a byte order mark;
- the Reporting API's freshness response shape and `decimalValue.value` in rows;
- that the service account permission "View app information and download bulk reports" alone opens the `pubsite_prod_…` bucket to the Cloud Storage JSON API.

First real check on Dotty: paste the vendor number and the bucket, press both **Test the connection** buttons, press **Refresh**, and compare the next day's App Store installs with App Store Connect → Analytics and the Play installs with Play Console → Statistics.
