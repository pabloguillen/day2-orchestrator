# Privacy: the notice, and the App Store and Google Play answers

When day2 adds something to a mobile app, the app's privacy answers in App Store Connect (App Privacy) and the Play Console (Data safety) may have to change. day2 can't edit them, so it works out the exact answers and asks the owner to update them **before the release that ships the change**. Code: `src/store-privacy.ts`; console: the app's **Privacy** page, and a card on the app's home while something is due.

## What changes when

day2 derives the answers from what's actually in the app — merged tickets — plus two owner settings:

| In the app | App Store (App Privacy) | Google Play (Data safety) |
|---|---|---|
| Field checks | Usage Data → Product Interaction (Analytics, App Functionality); Diagnostics → Crash Data, Performance Data, Other Diagnostic Data (App Functionality, Analytics), **not linked** while day2 keeps its default random id per launch | App activity → App interactions; App info and performance → Crash logs, Diagnostics, Other app performance data. Collected, not shared. Encrypted in transit |
| `day2.identify` (hashed user id) | Identifiers → User ID (Analytics); Product Interaction becomes **linked** | Personal info → User IDs (Analytics) |
| Retention treatments | + Product Personalization on Product Interaction and User ID | + Personalization |
| Fixed device id (setting) | Identifiers → Device ID (Analytics) | Device or other IDs (Analytics) |
| Ad conversions (setting, off by default) | **Tracking**: Usage Data → Advertising Data; User ID, Product Interaction and Advertising Data "Used to track you"; App Tracking Transparency prompt; the App Store page shows "Data Used to Track You" | App interactions and User IDs **shared** with the ad platforms (Advertising or marketing) |

The page shows only what changed since the owner last confirmed ("Add …", "add the purpose …", "Linked to the user → Yes"), plus the full set of answers. Confirming records the answers; day2 asks again when they change.

## Ad conversions in mobile apps

- **Off (default, recommended).** The field library never sends the ad's click id from a phone (`adClickIds` defaults to `"off"`), so nothing counts as tracking and the answers above stay as they are. Ad platforms optimise for clicks; day2 still measures every ad with its own tags.
- **After the user agrees.** The owner turns it on on the Privacy page. day2 tickets the code change: show Apple's App Tracking Transparency prompt (with `NSUserTrackingUsageDescription`), start the library with `adClickIds: "after_consent"`, and call `day2.allowAdTracking()` only after "granted". The click id stays on the device until then and is sent once, as an `ad_click` event. The answers change only once that ticket is merged.
- From mobile apps day2 never keeps the visitor's IP address or device details for ads (web visits only), so no location data is involved. Platforms that require them (Snapchat, Pinterest) get no conversions from mobile apps.

Web apps have no store answers; their privacy policy and consent banner are the app's own.

## The privacy notice

Every app (web and mobile) gets a drafted section for its privacy notice, from the same facts: what day2 collects, why, the legal basis (GDPR), the ad networks when conversions are on, and how long data is kept. English and German. Code: `src/privacy-notice.ts`.

- **day2 looks for the notice in the app's code**: a file named like privacy / datenschutz that talks about personal data. If it finds one, the Privacy page asks: *Can day2 add this section to it?* On yes, day2 tickets the change (reviewed like any other) and puts the section between markers — `day2:privacy-start v=<version>` … `day2:privacy-end` — so it can tell later whether the notice is current and replace only its own part.
- **Not found** (hosted elsewhere, a CMS…): the page shows the section to copy, and the owner confirms once it's added.
- When what day2 does changes, the section's version changes and the page (and the app's home) asks again.

It's a draft from what day2 actually does — not legal advice; the owner checks it against the rest of the notice.

## Purchases and ads (Money)

Once Money's purchase layer (`money:purchases`) or ad ticket (`money:ads`, `money:ads+att`) is merged, the answers gain Purchase History and the Google Mobile Ads SDK's data types (location, device id, ad interactions and diagnostics); tracking only with the App Tracking Transparency prompt (`money:ads+att`). Details in [money.md](money.md).
