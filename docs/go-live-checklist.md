# Going live: checklist

What's left before day2 runs in production. Nothing here is urgent — except
one thing that takes weeks: **Google's verification of the consent screen for
"Connect your stores"** (section 3). Start that first.
day2 keeps working locally on your own machine in the meantime. The details
for each step are in [deploy-hetzner.md](deploy-hetzner.md).

## 1. Decide the address

For example `app.yourdomain.com`. Every account below needs it.

## 2. Rent the server

Hetzner Cloud, about €5.49/month ([guide §1](deploy-hetzner.md#1-create-the-server)).

- [ ] A **CX23** with **Ubuntu 24.04** and your SSH key
- [ ] A firewall allowing only ports **22, 80 and 443**
- [ ] At your domain provider, a DNS **A record** pointing your address at the server's IP

## 3. Create the accounts for signing in

Each one gives you values for the settings file ([guide §3](deploy-hetzner.md#3-ways-to-sign-in)).

- [ ] **Email sending:** sign up with Postmark, Brevo or Amazon SES and verify
      your domain there. You get an SMTP address and password. This is the
      most important one, because it works for everyone.
      → `SMTP_URL`, `MAIL_FROM`
- [ ] **Google sign-in** (optional): create an OAuth client in Google Cloud.
      It takes about 10 minutes.
      → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- [ ] **Google for Connect your stores — start early, it can take weeks.**
      Use the sign-in client or a second Web client. Add the redirect URI
      `https://<address>/api/ads/connect/callback/googlecloud` and the scopes
      `cloud-platform` and `androidpublisher` to the OAuth consent screen, then
      **submit it for verification** (privacy policy, homepage, a short video
      of the flow, why each sensitive scope is needed). Until Google verifies
      it, only the test users you list can sign in, with an "unverified app"
      warning. Platform → Connect your stores shows what's missing
      ([connect.md](connect.md)).
      → `DAY2_GOOGLE_OAUTH_CLIENT_ID`, `DAY2_GOOGLE_OAUTH_CLIENT_SECRET`
- [ ] **Meta:** reconnect day2's Meta account on Platform → Ad accounts once,
      so it asks for `pages_show_list` (the Page list per app); include it in
      Meta's App Review.
- [ ] **GitHub App:** create it on GitHub with the settings from the guide's table.
      → `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`,
      `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`
- [ ] **Anthropic API key**, for the agent work.
      → `ANTHROPIC_API_KEY`

## 4. Set up the server

About 20 minutes. Log in by SSH and follow sections
[2](deploy-hetzner.md#2-prepare-it), [4](deploy-hetzner.md#4-get-the-code-and-fill-in-the-settings)
and [5](deploy-hetzner.md#5-check-it-works) of the guide.

- [ ] Install Docker and apply the one system setting the agent sandbox needs
- [ ] Download both repos (orchestrator and console, side by side)
- [ ] Copy `deploy/.env.example` to `deploy/.env` and fill in the values from
      step 3. Do this on the server only, never in a chat.
- [ ] Run `docker compose up -d --build`

## 5. Check it works

- [ ] Open your address and sign in by email link, Google and GitHub
- [ ] Connect a repo
- [ ] Run the one-line sandbox check from the guide
- [ ] On **Platform**, connect day2's Foreplay, Runway and Meta Ads accounts
- [ ] Later, for paid ads: set `DAY2_META_AD_ACCOUNT_ID` and give each app a
      Facebook Page ID on **Platform**

## 6. Growing apps: Live, Money, Store, Messages, Create

The details are in [deploying.md](deploying.md) and each module's own doc.

**On the server**
- [ ] The database changes `012`–`021` run by themselves at start. Check the
      log once for `[day2-db] applied`.
- [ ] `DAY2_PUBLIC_URL` is https, and Apple and Google can reach
      `/api/store-notify/apple|google|revenuecat/<app>` from the internet
      (Caddy passes them; no sign-in on these paths).
- [ ] The server may call out to `exp.host` (push), `api.storekit.itunes.apple.com`
      (purchase checks), `api.appstoreconnect.apple.com`,
      `androidpublisher.googleapis.com`, `pubsub.googleapis.com`,
      `oauth2.googleapis.com` and `itunes.apple.com` (store research).
- [ ] **Back up `DAY2_SECRETS_KEY`.** It now also unlocks the apps'
      In-App Purchase keys, push credentials and demo accounts. Losing it means
      every owner connects again.
- [ ] Optional: the Cloudflare inbox in front of the server
      (`deploy/inbox/setup.sh`), so settings, reports and store notifications
      survive a restart or an update.

**What still needs a Mac (no simulators on the server)**
- [ ] Device checks run as EAS Workflows (`DAY2_DEVICE_CHECKS=eas`).
- [ ] Store screenshots and app previews: decide between a Mac runner
      (e.g. a Mac mini or a cloud Mac) and EAS. Until then they work in local
      mode only.
- [ ] Build e2e by TesterArmy as the cloud test runner (deploying.md §10).

**Create (new Expo apps)**
- [ ] Create repos through the GitHub App instead of the server's `gh`
      login (not built yet).
- [ ] The agent sandbox needs network access to npm for `create-expo-app`.

**Before the first customer: one real run per module with a test app**
- [ ] Live: an experiment over the air, kept by day2.
- [ ] Money: a sandbox purchase on iOS and a test purchase on Android,
      checked through Apple's and Google's notifications; an AdMob test ad.
- [ ] Store: a listing change, screenshots and a review reply on a test app.
- [ ] Messages: a push to a real phone, a tap that opens the right screen.
- [ ] Create: one new app from description to TestFlight.

**Hosting (apps' backends on Supabase)**
- [ ] Operator: day2's Supabase organization exists and is on the Pro plan
      (or higher), so projects never pause and have daily backups.
- [ ] Operator: `SUPABASE_ACCESS_TOKEN` and `DAY2_SUPABASE_ORG_ID` are in
      `deploy/.env`; `bun run src/hosting/operator.ts` says "Connected".
- [ ] Operator: an email sender for apps (`DAY2_HOSTING_SMTP_URL`,
      `DAY2_HOSTING_SMTP_FROM`) on a domain with SPF and DKIM.
- [ ] One hosted test app end to end: project, sign-in by email and Apple,
      a migration through a pull request preview, a release that applies it,
      one day of credits charged ([hosting.md](hosting.md)).

**Legal**
- [ ] day2's own privacy notice and data processing terms list the new
      processors and data: Expo (push), Cloudflare (inbox), Apple and Google
      (purchase notifications), push tokens and purchase records per hashed user.
- [ ] day2's terms and privacy notice say that day2 **learns across apps from
      anonymous outcomes** (kind of app, kind of change, relative effect, size
      bucket — no app names, texts, user numbers, revenue or ids), that it is
      on by default, and how to turn it off (People & workspace → Learning
      across apps). Wording to start from: [memory-and-learning.md](memory-and-learning.md) §2.
- [ ] The same notice says day2 keeps short notes of what the owner tells it
      about each app ("What day2 knows"), never secrets or data about the
      app's users, and that the owner can edit or remove them.

## 6a. Memory and learning

- [ ] Migrations `022_memory.sql` and `023_learning.sql` ran (check `schema_migrations`).
- [ ] Decline something with a reason on a test app; within a minute it shows on
      **What day2 knows** (under "You said no to", and as a note to confirm).
- [ ] As an operator, open **Platform → What works across apps** and see the
      library (empty at first) and the build playbook.

## 7. For each app in the stores: the Setup tab

About 15 minutes per app, after connecting App Store Connect and Google Play
on **Connect your stores**. On the app's **Store** page → **Setup**:

- [ ] Approve (or correct) what day2 proposed: links, contact, categories,
      content rights, age rating, App Review contact, price and countries,
      Play contact details
- [ ] If reviewers must sign in: enter the demo account on **App Review
      information** (stored encrypted, never shown again)
- [ ] Approve the Google Play icon and feature graphic (and app previews,
      on a Mac)
- [ ] Do each **Your step** with its prepared answers: Play's content rating,
      target audience, ads, app access, declarations, category and tags; the
      privacy answers on the **Privacy** page
- [ ] Click **Check again** and see every item as Done or Not needed


## 8. For each app in the stores: Numbers

- [ ] For each app in the stores, on **Connect your stores**: paste the App
      Store vendor number (checked with Apple), drop a one-time Admin key for
      App Analytics, and check that Google's steps (Reporting API, Play invite,
      reports bucket) are green — paste the Cloud Storage URI if day2 couldn't
      find it (see [numbers.md](numbers.md))
- [ ] A day later, check that **Numbers** shows App Store and Google Play
      installs next to day2's own numbers

- [ ] Supabase is listed as a **subprocessor** for hosted apps (with the
      regions in use), and Supabase's **DPA** is signed for day2's organization.
- [ ] The terms say owners can move their backend to their own Supabase
      organization at any time, and who pays Supabase after that.
