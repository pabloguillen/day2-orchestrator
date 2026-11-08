# Setting up day2 itself, step by step

This is what you (the operator) set up **once for day2**. It's not per customer
app: customers never see any of it, they only get buttons that work.

You can do it now, with day2 running on your Mac. Everything uses the address
`https://app.gora8.com`. That's already your `DAY2_PUBLIC_URL`, and the tunnel
makes it reachable from outside.

**Ground rules**
- Keys and secrets go into `~/Projects/day2/day2/orchestrator/.env` only.
  Never paste them in a chat, a ticket or an email.
- To open `.env`, type this in Terminal: `open -e ~/Projects/day2/day2/orchestrator/.env`.
  Add each value on its own line, as `NAME=value`, with no spaces or quotes.
  Save with ⌘S.
- Websites change their menus from time to time. If a button has a slightly
  different name, look for the closest match. If you're stuck, send a
  screenshot with the secrets covered.

**Before steps 1h and 2e:** gora8.com must be live with an Impressum,
privacy policy and terms. See [website.md](website.md).

Order: start the three reviews first (steps 1–3), because they take days to
weeks. You can do the rest while you wait.

| # | What | Time you spend | Waiting time |
|---|---|---|---|
| 1 | Google sign-in client for "Connect your stores" | 20 min | Verification: weeks |
| 2 | Meta developer app (gora8) | 30 min | Business verification + App Review: days to weeks |
| 3 | TikTok developer apps (ads, and posting) | 15 min + 15 min | 2–3 business days; posting audit: days to weeks |
| 4 | day2's own ad accounts | 10 min | none |
| 5 | Supabase | done | — |
| 6 | Optional: Creatify, Runway, YouTube | 5 min each | none |
| 7 | Restart server, tunnel, inbox | 5 min | none |

---

## 1. Google sign-in client for "Connect your stores"

Customers click "Sign in with Google", and day2 sets up their Google Play side
for them. For that, day2 needs its own Google OAuth client.

### 1a. Create the project
1. Go to **https://console.cloud.google.com** and sign in with the Google
   account that should own gora8, ideally one on your gora8.com domain.
2. At the top left, click the **project picker** (next to "Google Cloud") →
   **New project**.
3. Project name: `gora8`. Organization: yours, if one is offered, otherwise
   "No organization".
4. Click **Create**. Wait a few seconds, then select the `gora8` project in the
   project picker.

### 1b. The consent screen ("Google Auth Platform")
This is what customers see when they click "Sign in with Google".

5. In the search bar at the top, type **Google Auth Platform** and open it.
   It used to be called "OAuth consent screen".
6. Click **Get started**.
7. **App information:** app name `gora8`; user support email: your email.
   Click **Next**.
8. **Audience:** choose **External**, because customers have their own Google
   accounts. Click **Next**.
9. **Contact information:** your email. Click **Next**.
10. Accept the user data policy and click **Continue** → **Create**.

### 1c. Branding (needed later for verification, worth doing now)
11. In the left menu, click **Branding**.
12. Upload a square logo (at least 120×120 px).
13. **Application home page:** `https://gora8.com`
14. **Privacy policy:** the URL of your privacy policy, e.g. `https://gora8.com/privacy`.
    It must be live before you submit for verification.
15. **Terms of service** (optional): e.g. `https://gora8.com/terms`.
16. **Authorized domains:** add `gora8.com`.
17. Click **Save**.

### 1d. The permissions (scopes)
18. In the left menu, click **Data Access** → **Add or remove scopes**.
19. In "Manually add scopes", paste these two lines and click **Add to table**:
    ```
    https://www.googleapis.com/auth/cloud-platform
    https://www.googleapis.com/auth/androidpublisher
    ```
20. Also tick `openid` and `.../auth/userinfo.email` in the list if they're
    there. They're not sensitive.
21. Click **Update**, then **Save**.

### 1e. Test users (so you can try it with Dotty now)
22. In the left menu, click **Audience** → under **Test users**, click
    **Add users**.
23. Add the Google account that owns **Dotty's Play Console**. Click **Save**.
    - Until Google verifies the app, only test users can sign in (up to 100),
      and they see an "unverified app" warning first. Click **Continue** there.
    - For test users, Google ends the sign-in after 7 days. That's fine: day2
      only needs it for a few minutes during setup.

### 1f. The OAuth client
24. In the left menu, click **Clients** → **Create client**.
25. Application type: **Web application**. Name: `day2 connect your stores`.
26. Under **Authorized redirect URIs**, click **Add URI** and paste exactly:
    ```
    https://app.gora8.com/api/ads/connect/callback/googlecloud
    ```
27. Click **Create**.
28. A window shows the **Client ID** and **Client secret**. Copy both now:
    Google may not show the secret again. If it doesn't, you can add a new
    secret on the client's page.

### 1g. Into `.env`
29. Add these two lines to `.env`, with the values from step 28:
    ```
    DAY2_GOOGLE_OAUTH_CLIENT_ID=
    DAY2_GOOGLE_OAUTH_CLIENT_SECRET=
    ```
30. Save.

### 1h. Start the verification (takes weeks, start now)
Not needed for testing with Dotty, but needed before real customers can sign in.

31. Make sure `https://gora8.com` and the privacy policy page are live. The
    privacy policy must say what day2 does with Google data: it creates a
    service account and turns on APIs in the customer's own project; it
    keeps the Google sign-in for at most one hour, then revokes it.
32. Verify that you own `gora8.com` in **Google Search Console**
    (https://search.google.com/search-console) with the same Google account.
33. Record a short screen video (1–3 minutes, can be unlisted on YouTube):
    Dotty → Connect your stores → Sign in with Google → the consent screen
    with the two permissions → what day2 does with them.
34. Back in **Google Auth Platform**, open **Verification Center** (or
    **Audience → Publish app**), and click **Prepare for verification** /
    **Submit**.
35. Fill in why each scope is needed:
    - **cloud-platform:** "To create a service account, turn on the Android
      Publisher, Play Developer Reporting, Pub/Sub and Firebase APIs, and set
      up Play purchase notifications in the customer's own Google Cloud
      project. Google offers no narrower scope for IAM, Service Usage and
      Firebase management."
    - **androidpublisher:** "To invite the service account to the customer's
      Play Console with the permissions day2 needs, and to check the
      connection."
36. Submit. Google answers by email, often with questions. Reply to those, or
    forward them to me.

---

## 2. Meta developer app (gora8)

You already have the app "gora8". These steps finish it.

### 2a. The keys
1. Go to **https://developers.facebook.com/apps** and open **gora8**.
2. In the left menu, open **App settings** → **Basic**.
3. Copy **App ID** and **App secret** (click **Show**; Meta asks for your
   password).
4. Still on that page, fill in:
   - **Privacy policy URL:** e.g. `https://gora8.com/privacy`
   - **Terms of service URL:** e.g. `https://gora8.com/terms`
   - **App domains:** `gora8.com`
   - **Category:** Business and pages
   - **App icon** (1024×1024)
5. Click **Save changes**.

### 2b. Your business ID
6. Go to **https://business.facebook.com/settings** and pick the business
   portfolio for gora8. If you have none, create one with **Create business
   portfolio**.
7. Open **Business info**. Copy the **Business portfolio ID** (a long number).
   You can also see it in the address bar as `business_id=…`.
8. Back in the developer app (step 1), check that the app is connected to this
   business: **App settings → Basic → Business portfolio**. If it isn't, pick
   it there.

### 2c. Into `.env`
9. Add:
   ```
   META_APP_ID=
   META_APP_SECRET=
   DAY2_META_BUSINESS_ID=
   META_LOGIN_CONFIG_ID=
   ```
   `META_LOGIN_CONFIG_ID` is the login configuration from step 15a (gora8
   is a Business-type app, so its sign-in needs one).
10. Save.

### 2d. Products and the redirect URL
11. In the app, open **Use cases** (or **Add product**). Add **Marketing API**
    (it may be called "Create & manage ads with Marketing API"), and
    **Facebook Login for Business**. For Social (posting on customers'
    Instagram and Facebook Page, [social.md](social.md)) also add
    **Instagram** ("Manage messaging & content on Instagram", the API setup
    *with Facebook Login*) and **Pages** ("Manage everything on your Page").
12. In the left menu, open **Facebook Login for Business** → **Settings**.
13. Under **Client OAuth settings**, make sure **Client OAuth login** and
    **Web OAuth login** are on.
14. In **Valid OAuth Redirect URIs**, paste exactly:
    ```
    https://app.gora8.com/api/ads/connect/callback/meta
    ```
    Meta may add a slash at the end; that's fine.
15. Click **Save changes**.

**The login configuration** (needed for Business-type apps like gora8; if
the Instagram use case says "no compatible configuration found", this is
the fix):

15a. In the left menu, open **Facebook Login for Business** →
     **Configurations** (**Konfigurationen**) → **Create configuration**.
     Name it e.g. "gora8 connect", pick **General login** and the token
     type **User access token**.
15b. Tick these 10 permissions: `ads_management`, `ads_read`,
     `business_management`, `instagram_basic`, `instagram_content_publish`,
     `instagram_manage_insights`, `pages_manage_posts`,
     `pages_read_engagement`, `pages_show_list`, `read_insights`.
     Create it.
15c. Copy its **Configuration ID** (gora8's: `5591455221080623`) into
     `.env` as `META_LOGIN_CONFIG_ID=` (step 9) and restart day2. day2 then
     opens Meta's sign-in with this configuration instead of a permission
     list, for every Meta connect (day2's ad account, the app owner's ad
     account, the owner's Page and Social posting). Optional:
     `META_LOGIN_CONFIG_ID_ADS` / `META_LOGIN_CONFIG_ID_SOCIAL` use a
     different configuration for the ad-account connect or the Page/Social
     connect. Without `META_LOGIN_CONFIG_ID`, day2 asks for the permissions
     directly (works for non-Business apps).

### 2e. Business verification (takes days)
16. Go to **https://business.facebook.com/settings** → **Security center**.
17. Under **Business verification**, click **Start verification**.
18. Enter the legal name, address and phone number exactly as they appear on
    an official document (Handelsregister extract, Gewerbeanmeldung or a
    utility bill), plus the website `gora8.com`.
19. Choose how to confirm (email on your gora8.com domain is fastest, or
    phone), and upload the document if asked.
20. Submit. Meta answers within a few days.

### 2f. App Review for the ad and posting permissions (after business verification)
21. In the developer app, open **App Review** → **Permissions and features**.
22. For each of these, click **Request advanced access**. The line after each
    is the usage justification, ready to paste:
    - `ads_management` — gora8 creates, changes, pauses and stops ad
      campaigns, ad sets and ads in the ad account the business connected,
      within the budget its owner set.
    - `ads_read` — gora8 reads results (spend, impressions, clicks,
      conversions) of the ads it runs, to show them to the business owner and
      move budget to what works.
    - `business_management` — gora8 lists the ad accounts and Facebook Pages
      the signed-in person can use, so they can pick the one for their app,
      and requests access to the Page their ads run as.
    - `pages_show_list` — gora8 lists the Pages the signed-in person manages,
      so they can pick the Page for their app (for its ads and its posts).
    - `pages_read_engagement` — gora8 reads the Page's name, its linked
      Instagram account and the reactions, comments and shares on the posts it
      published for the business, to show results and improve the next posts.
    - `pages_manage_posts` — gora8 publishes photo and Reel posts on the
      business's own Facebook Page: only posts the owner approved in gora8 (or
      allowed to go out on their own).
    - `instagram_basic` — gora8 reads the linked Instagram professional
      account's id and username, to show which account it posts to and to
      find the posts it published.
    - `instagram_content_publish` — gora8 publishes Reels, feed posts and
      Stories on the business's own Instagram professional account: only posts
      the owner approved in gora8 (or allowed to go out on their own).
    - `instagram_manage_insights` — gora8 reads reach, views, likes,
      comments, shares and saves of the posts it published, 1, 3 and 7 days
      after posting, to show the owner how they did and make better posts.
    - `read_insights` — gora8 reads view counts of the Facebook Page posts it
      published, to show the owner how they did and make better posts.
23. For each, Meta asks how you use it and for a **screen recording**. Record
    day2's console:
    - Ads: Platform → Ad accounts → Connect Meta → Meta's consent screen →
      back in day2 → choosing the ad account and the Page.
    - Posting: an app → **Social** → Connect with Facebook → Meta's consent
      screen → picking the Page → a post waiting for approval (preview, edit
      the caption, Approve) → the post on Instagram and the Page → its results
      on the Social page the next day.
24. Submit. Until approval, only people with a role on the app (you, and
    anyone you add under **App roles**) can connect. That's enough for Dotty.

---

## 3. TikTok developer app (start now: 2–3 business days)

### 3a. Become a developer
1. Go to **https://business-api.tiktok.com/portal** and click **Register**
   (top right). Or **Log in** if you already have a TikTok for Business
   account.
2. Confirm your email and phone with the codes TikTok sends.
3. Top right, click **Become a Developer**.
4. "What best describes you": choose the option for agencies or tool
   providers (for example "Marketing partner"), because day2 runs ads for
   other businesses. If none of the options fits, "Direct advertiser" works
   too.
5. Enter company details: gora8, website `https://gora8.com`. Click **Next**.

### 3b. Create the app
6. In **Create application** (or **My Apps → Create new**):
   - **App name:** `gora8`
   - **Description:** e.g. "gora8 builds and grows mobile apps for small
     teams and runs their TikTok campaigns: creating campaigns, ad groups
     and ads, uploading creatives, and reading results."
   - **Advertiser redirect URL:**
     ```
     https://app.gora8.com/api/ads/connect/callback/tiktok
     ```
7. Under permissions, tick at least: **Ad account management**, **Ads
   management**, **Reporting**, **Creative management** (names may differ
   slightly). Also tick **Audience management** if it's offered.
8. Click **Confirm** / **Submit**.
9. Wait for approval. The status is on **My Apps**. It takes about 2–3
   business days.

### 3c. Into `.env` (after approval)
10. Open **My Apps** → **gora8**. Copy the **App ID** and the **Secret**.
11. Add:
    ```
    TIKTOK_APP_ID=
    TIKTOK_APP_SECRET=
    ```
12. Save.

### 3d. TikTok Content Posting API (posting on customers' TikTok)

This is a **different portal and a different app** from 3a–3c: the Marketing
API (ads) lives on business-api.tiktok.com; posting videos to a customer's own
TikTok is the **Content Posting API** on developers.tiktok.com.

13. Go to **https://developers.tiktok.com** and log in (a TikTok account;
    use gora8's). Open **Manage apps** → **Connect an app** (or **Create
    app**). Choose an organization for gora8 if asked.
14. **Basic information:** app name `gora8`, icon, category (e.g. Business /
    Productivity), description e.g. "gora8 makes social posts for small app
    businesses and, with the owner's approval, publishes them on the owner's
    own TikTok account, then shows how they did." Terms URL
    `https://gora8.com/terms`, privacy URL `https://gora8.com/privacy`.
    Platform: **Web**, website `https://gora8.com`.
15. **Add products:** **Login Kit** and **Content Posting API**. In Content
    Posting API, turn on **Direct Post**.
16. **Scopes:** `user.info.basic`, `video.publish`, `video.upload`,
    `video.list`.
17. **Login Kit → Redirect URI** (web), exactly:
    ```
    https://app.gora8.com/api/ads/connect/callback/tiktokposts
    ```
18. **Sandbox** (to test with Dotty before the audit): add Dotty's TikTok
    account as a target user. Then **Submit for review** for the app itself;
    TikTok checks the app details and the demo.
19. Copy **Client key** and **Client secret**, and add to `.env`:
    ```
    TIKTOK_CONTENT_CLIENT_KEY=
    TIKTOK_CONTENT_CLIENT_SECRET=
    ```
20. **Audit for public posts (after the app is approved).** Until TikTok
    audits the app, every post is private ("Only me"), at most 5 creators can
    post in 24 hours, and the posting account must be private. The console
    says "TikTok audit pending: posts are private". To apply: in the app's
    Content Posting API page, open **Apply for audit** (Direct Post). TikTok
    wants:
    - a screen recording of the full flow in gora8: Social → Connect TikTok →
      TikTok's consent screen → a post waiting for approval with the preview,
      the account name shown, the visibility dropdown with nothing picked,
      Comment/Duet/Stitch off by default, the commercial content toggle with
      "Your brand" / "Branded content" and the declaration text, editable
      caption → Approve → the post on TikTok;
    - that the app posts only original content the creator made with the
      app and approved (gora8: the owner approves every TikTok post, even with
      "Posts go out on their own" on);
    - expected numbers: posts per creator per day (gora8 sends at most 2) and
      creators per day;
    - the privacy policy and terms URLs.

---

## 4. day2's own ad accounts

Customers' ad spend runs through day2's ad accounts by default and is billed
to them in credits. Do this after steps 2 and 3, and after the restart in
step 7.

1. You need an **ad account** on each platform first:
   - **Meta:** https://business.facebook.com/settings → **Accounts → Ad
     accounts → Add → Create a new ad account**. Currency EUR, time zone
     Europe/Berlin. Add a payment method under **Billing**.
   - **TikTok:** https://ads.tiktok.com → create an advertiser account for
     gora8, then add a payment method.
2. Open the day2 console → **Platform** → **Ad accounts**.
3. Next to **Meta**, click **Connect**. Sign in, allow the permissions, then
   pick gora8's ad account. Do this again even if you connected before, so
   day2 also gets `pages_show_list`.
4. Next to **TikTok**, click **Connect**, sign in, and pick the advertiser
   account.
5. The page shows each platform as **Connected**. Platforms that are missing
   keys list the missing setting names.

---

## 5. Supabase

Done: day2 connects to the "gora8" organization. It's on the Free plan, which
is fine until go-live.

Demo backends for real screens (creative-quality.md §2b) are created in the
same organization (`<app>-<id>-demo`) — by day2 itself, for every app with
growth on (the automatic pipeline: cast → approval → demo backend → flow PR
→ capture). The Free plan allows **2 active projects**: with the hosting
projects that's quickly full — the pipeline's "Demo backend" step then
needs attention ("no room for another project") on Growth → Formats,
creates nothing, and tries again once a day. On the Free plan day2 pauses a
demo project after each capture (`DAY2_DEMO_PAUSE_AFTER_CAPTURE=off` keeps
it running); paused projects don't count against the 2. **On a paid plan
Supabase can't pause projects** — demo projects keep running and are billed
compute (see go-live-checklist.md).

Demo projects are deleted when an app is removed, or after its growth has
been off for 30 days. Switches: `DAY2_REAL_SCREENS=off` stops the automatic
pipeline (buttons still work), `DAY2_REAL_SCREENS_WAIT_MINUTES` (default 45)
is how long the first How it works post waits for real screens.

## 5b. Capturing real screens on your Mac (Xcode, Maestro, EAS)

Posts show your apps' real screens, captured on the iPhone Simulator.

1. **Xcode** from the Mac App Store; open it once, accept the licence, and in
   Xcode → Settings → Components install an iOS Simulator runtime. Check:
   `xcrun simctl list devices available` lists an iPhone.
2. **Maestro** (the flow runner): in Terminal
   `curl -fsSL "https://get.maestro.mobile.dev" | bash`, then open a new
   Terminal window and check `maestro --version`. (Java 17+ is needed; macOS
   asks to install it on first run if missing — `brew install openjdk@17`.)
3. Run day2 on the Mac (`bun run src/api-server.ts` with your `.env`): with
   Xcode present captures run locally (`DAY2_CAPTURE=local` forces it,
   `off` stops it).
4. Optional, Android: Android Studio with one virtual device (Device
   Manager); used when an app has no iOS build.
5. **EAS instead of the Mac** (deployed day2): a server without Xcode
   captures on EAS by default (`DAY2_CAPTURE=eas` forces it, `off` stops
   captures); the app's Expo account must be connected (Connect your
   stores). day2 runs an EAS Workflow (simulator build with its `day2-demo`
   profile + a Maestro job) and downloads the screenshots artifact. That
   download isn't verified against a real run yet; if it fails day2 tries
   the Android emulator when the server has one (adb, emulator, Maestro,
   `ANDROID_HOME`, an AVD, `/dev/kvm`; `DAY2_ANDROID_FALLBACK=off` skips
   it), else the "Capture screens" step needs attention and asks for
   uploads.

---

## 6. Optional: videos and trend research

Without these, day2 works fine. It skips presenter videos, generated video
shots and YouTube trends, and says so. Owners can also connect their own
accounts for any creator tool on Growth → Accounts (docs/creator-tools.md);
the keys below are day2's own accounts, billed to customers in credits.

**Creatify** (AI presenter videos)
1. Sign up at https://creatify.ai and choose a plan with API access.
2. Open **Settings → API** (or **API access**) and copy the **API ID** and
   **API key**.
3. Add to `.env`:
   ```
   CREATIFY_API_ID=
   CREATIFY_API_KEY=
   ```

**Runway** (generated motion shots)
1. Sign up at https://dev.runwayml.com and add credits.
2. Create an **API key** and copy it.
3. Add to `.env`:
   ```
   RUNWAYML_API_SECRET=
   DAY2_ADS_RUNWAY=on
   ```

**HeyGen** (presenter videos with stock avatars)
1. Sign up at https://app.heygen.com and buy API credits (pay as you go).
2. Open **Settings → API** and copy the **API key**.
3. Add `HEYGEN_API_KEY=` to `.env`.

**Luma** (generated video clips)
1. Sign up at https://platform.lumalabs.ai and add credits.
2. Create an **API key** (starts with `luma-api-`; shown once).
3. Add `LUMA_API_KEY=` and, from your plan, `LUMA_USD_PER_CREDIT=` to `.env`.

**Google** (generated video clips via Gemini Omni)
1. Open https://aistudio.google.com/apikey and create an API key in the
   `gora8` project; turn on billing for it.
2. Add `GEMINI_API_KEY=` to `.env`.

**ElevenLabs** (voiceovers and music)
1. Sign up at https://elevenlabs.io and choose a plan with API access.
2. Open **Developers → API keys**, create a key and copy it.
3. Add `ELEVENLABS_API_KEY=` to `.env`.

**OpenAI Images** (image backgrounds)
1. Open https://platform.openai.com/api-keys (organization verified for image
   models) and create a key.
2. Add `OPENAI_API_KEY=` to `.env`.

Runway and Creatify are used for every app by default once set; the others
are offered to owners, who switch them on per app.

**YouTube** (trend research)
1. In Google Cloud (the `gora8` project from step 1), search for **YouTube
   Data API v3** and click **Enable**.
2. Open **APIs & Services → Credentials → Create credentials → API key**.
3. Click the new key → under **API restrictions**, choose **Restrict key** →
   **YouTube Data API v3**. Save.
4. Add to `.env`:
   ```
   YOUTUBE_API_KEY=
   ```

---

## 7. Restart after changing `.env`

day2 reads `.env` only when it starts.

1. **Server:** in the Terminal window where it runs, press **Ctrl+C**. Then:
   ```
   cd ~/Projects/day2/day2/orchestrator && bun run src/api-server.ts
   ```
2. **Tunnel:** in its Terminal window, press **Ctrl+C**. Then:
   ```
   cd ~/Projects/day2/day2/orchestrator && DAY2_TUNNEL_HOST=app.gora8.com deploy/tunnel/day2-tunnel.sh
   ```
3. **Inbox at Cloudflare.** Run this once now, because it has new routes, and
   again whenever I tell you it changed:
   ```
   cd ~/Projects/day2/day2/orchestrator && deploy/inbox/setup.sh
   ```
4. **Check:** open the console → **Platform**. The connection checks show
   what's set and what's still missing.

---

## Then: test with Dotty as the first customer

1. Console → Dotty → **Connect your stores**.
2. **Google:** click Sign in with Google, using the Play Console owner you
   added as a test user in step 1e.
3. **Expo:** follow the step and paste the robot token.
4. **Apple:** go through the checklist.
5. **Meta:** pick Dotty's Facebook Page.
6. **Social:** Dotty → Social → Connect with Facebook (pick the Page with
   Dotty's Instagram account) and Connect TikTok, then **Make a post now**
   and approve it ([social.md](social.md), "First run with Dotty").

Send me every error or screenshot (secrets covered).
