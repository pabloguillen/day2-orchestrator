# Money: how the app earns

day2 plans how an app earns, sets up the products and prices in the App Store and Google Play, has the purchase screen and ads built in the app's own style, checks every purchase with Apple and Google itself, and tests prices, paywalls and ads — always with the owner deciding about prices.

Code: `src/money/`. Console: the app's **Money** page. Design: [self-improving-app.md](self-improving-app.md).

## The ways to earn

| Way | How it works | Good for |
|---|---|---|
| **Subscription** | Users pay every week, month or year, often after a free trial. Apple and Google renew it and tell day2. | Apps people come back to (tools, learning, creative apps). |
| **One-time unlock** | Pay once, keep it forever (e.g. "Pro"). | Apps used now and then; people who dislike subscriptions. |
| **Consumables** | Packs that get used up (credits, sticker packs). | Apps where use varies a lot. |
| **Rewarded ads** | The user *chooses* to watch an ad for a reward (extra stickers). | Free users who'd never pay. |
| **Full-screen ads** | An ad between two screens. day2 never shows them in a user's first session, and caps them. | Simple free apps with many users. |
| **Banner ads** | A small strip on some screens. Earns little. | Rarely worth it. |
| **Not yet** | With fewer than 20 people using the app, there is nothing to learn from. day2 waits (or plans on request). | New apps (Dotty right now). |

## How day2 decides — and how you stay in control

1. **The plan.** An agent researches how the leading apps of the category earn (with sources you can open), looks at the app's code, profile, brand and how often people use it, and proposes a mix with prices for your base country (EUR for Germany by default) and the main markets, where paywalls appear, where ads go and how often, and what not to do. It's refreshed every 60 days or when users grow 5×. **Nothing happens until you approve it.**
2. **Guardrails day2 always keeps:** no full-screen ads in the first session; caps on every ad; no paywall before the first success; when many users may be minors (for example a young German-speaking audience), no tracking prompt, only non-personalized ads tagged for users under the age of consent, and no full-screen ads.
3. **Products and prices.** Approving the plan creates the products at those prices in App Store Connect and Google Play (with the App Store Connect key and Google Play service account you connected for releases). Other countries get Apple's and Google's matching ("equalized") prices unless the plan sets one. New products and price changes later are **Ask me first** by default.
4. **The app's code**, through three tickets for the build agent: the purchase layer (`expo-iap`), the paywall screen in the app's style, and ads (`react-native-google-mobile-ads` with Google's consent form). The native packages go into Live's single "native foundations" release. After that, texts, products, trial and ad frequency change over the air through Live config.
5. **Tests.** One at a time, through Live's experiments: paywall layout, trial length, price, how often ads show, ad on or off. Each is judged on revenue per user, and stops if users come back less after a week or the app crashes more. Wording and ad tests follow **day2 decides** (default); price and trial tests make new products and wait for your OK. A price test uses a *different product* at the other price — Apple and Google don't allow different prices for one product in the same country.

## What you do once

| Step | Where | Why |
|---|---|---|
| Accept Apple's **Paid Apps agreement**, add bank account and tax forms | App Store Connect → Business | Without it nothing can be sold, not even tested in TestFlight. |
| Set up a **payments profile** | Play Console → Settings → Payments profile | Google pays you through it. |
| Create the **In-App Purchase key** and paste it on the Money page | App Store Connect → Users and Access → Integrations → In-App Purchase | A separate key from the release key; day2 uses it to look up purchases. Stored encrypted, never shown again. day2 tries it with Apple first. |
| Set the **server notification URL** (Version 2, production and sandbox) to `https://<day2>/api/store-notify/apple/<app>` | App Store Connect → the app → App Information | Apple tells day2 about every purchase, renewal and refund. "Send a test notification" checks it. |
| Create the **Pub/Sub topic + push** and enter the topic in Play Console | Google Cloud + Play Console → Monetization setup | Google tells day2 about purchases. day2 creates the topic itself when the service account may; "Send test notification" in Play Console checks it. |
| Add the **first in-app purchase to an app version** | App Store Connect → the next version → In-App Purchases and Subscriptions | Apple's rule: the first in-app purchase is reviewed together with an app version. Each product also needs a review screenshot. |
| If the plan has ads: create an **AdMob account**, add the app, create one ad unit per placement, enter the ids on the Money page, put AdMob's `app-ads.txt` line on your website | admob.google.com | Ads are paid into your own AdMob account. |

Every step has **Do it with me** on the Money page: one screen at a time, with the page to open.

## How day2 knows what was really paid

- **Apple:** every App Store Server Notification is signed. day2 checks the certificate chain up to Apple Root CA – G3 (pinned by fingerprint), Apple's marker in the certificates, and the signature, before it believes anything — the same for the transaction inside. Lookups use the App Store Server API with the In-App Purchase key.
- **Google:** each Pub/Sub push carries a token signed by Google for the push's service account; day2 checks it, then reads the purchase from the Google Play Developer API (`purchases.subscriptionsv2`, `purchases.products`). It acknowledges purchases the app didn't (Google refunds unacknowledged ones after 3 days).
- **When day2 was asleep:** the inbox at Cloudflare keeps the notification and day2 replays it later. Apple's are signed, so nothing changes. Google's arrive without Google's token, so day2 trusts nothing in them: purchases are read from Google's API anyway, refunds count only if Google lists the order as voided, and a test notification proves nothing.
- **Who bought:** the app passes `day2.purchaseToken()` as Apple's `appAccountToken` and Google's `obfuscatedAccountId` — a UUID derived from the hashed user (`sha256("day2-purchase:" + hashedUser)`, first 16 bytes, version 5, RFC 4122 variant). day2 maps it back to the hashed user, their test groups and where they came from. No name, email or receipt is stored.
- **Each notification counts once** (by its id), and a failed lookup is retried (1 min, 5 min, 30 min, 2 h, 12 h, then daily, 10 tries). Test purchases (sandbox, TestFlight) are kept but never counted.
- **For Live and the metrics,** verified records become server events (`props.by: "store"`, not counted as the user being active): `purchase_verified` (the app already reported the purchase as `revenue`, so it isn't added again), `revenue` for renewals, and `refund`.
- **Ads:** the app reports each ad's estimated earnings from AdMob's paid event as `day2.revenue({ kind: "ad" })`. AdMob's reporting API could be read later to reconcile — not built.
- **RevenueCat:** if an app already uses it, day2 reads RevenueCat's webhooks instead (the app sets the subscriber attribute `day2_token` to `day2.purchaseToken()`).

The Money page shows revenue by source (subscriptions, purchases, ads), revenue per user, paying users and ARPPU, trials that became paid, refunds and active subscriptions — by test group and by where users came from — in the app's currency.

## Fees

Amounts on the Money page are what users paid, tax included. You receive less:

- **Apple** keeps 30%, or 15% in the App Store Small Business Program (under $1M a year, you have to enroll) and for subscriptions after a subscriber's first year. In Germany the price includes 19% VAT, which Apple pays out of it.
- **Google** keeps 15% of the first $1M a year and of all subscriptions, 30% above that for one-time purchases.
- **AdMob** pays out your share; the amounts day2 shows are AdMob's estimated earnings for you.
- Alternative EU terms (Digital Markets Act) exist; day2 doesn't use them.

## Privacy and the store answers

day2 adds to the App Store and Google Play privacy answers (Privacy page) once the code is merged:

- **Purchases:** Apple → Purchases → Purchase History (App Functionality, Analytics; linked to the user when the app identifies users). Google → Financial info → Purchase history (collected, not shared). No payment details are ever seen by day2.
- **Ads (Google Mobile Ads SDK):** Apple → Coarse Location, Device ID, Product Interaction, Advertising Data (Third-Party Advertising, Analytics) and Performance Data; "Used to track you" only when the tracking prompt is in the app. Google → Approximate location, Device or other IDs, App interactions, Diagnostics (shared, for advertising, analytics and fraud prevention).
- The privacy notice should mention purchases and ads; the Privacy page drafts the section.

## Settings

- **New products and prices:** Ask me first (default) / day2 decides.
- **Tests of wording, layout and ads:** day2 decides (default) / Ask me first.
- **Money for this app:** on/off. Currency, base country and store language can be changed through the API.

## Not verified against real accounts

Built from Apple's and Google's documentation and tested with fakes only. Check on Dotty before trusting it:

- App Store Connect: subscription prices per territory (`subscriptionPrices`), free-trial offers per territory (`subscriptionIntroductoryOffers` with a territory), review screenshot upload, and in-app purchase price schedules — request shapes not verified.
- Google Play: `monetization.subscriptions` create with regional configs, base-plan and offer activation, `pricing:convertRegionPrices`, and one-time products through `inappproducts` (Google is moving to `monetization.onetimeproducts`) — not verified. Google doesn't return the price of a one-time purchase; day2 uses its own price for the buyer's country.
- App Store Server API lookups and test notifications; the In-App Purchase key test (a lookup of a transaction id that can't exist, expecting 4xx).
- Pub/Sub setup by the service account (needs Pub/Sub Admin; older Google Cloud projects may also need the Pub/Sub service agent to create tokens).
- The Google Mobile Ads data disclosure rows (from Google's guidance, re-check its current page).
- The `expo-iap` and `react-native-google-mobile-ads` API names in the tickets (the build agent checks the installed versions).
- AdMob reporting API (not built). App Store notification URL can only be set by hand (no API used).
