# Mobile releases (React Native / Expo)

day2 ships what's merged by itself. Code: `src/mobile-release/`; console: **Releases**.

## The two paths

Every pass (on the backlog timer), when main has new commits and no merge landed in the last 20 minutes, day2 checks out main and compares each platform's **runtime version** (the native fingerprint, `runtimeVersion: { policy: "fingerprint" }`) with the store build users have:

- **Same runtime → over-the-air update** (EAS Update): `eas update --rollout-percentage 10`, then 50%, then 100%. Each stage runs at least 2 hours (4 at 50%) and needs 50 launches of the new update; a quiet app goes on after three clean days. No App Review.
- **Different runtime → store release**:
  1. The version is raised (1.4.0 → 1.4.1) in a one-line pull request day2 merges itself.
  2. EAS Build for iOS and Android (`autoIncrement` + remote app versions), then EAS Submit to TestFlight and Google Play's internal track.
  3. App Store Connect: export compliance (no non-exempt encryption) when it's missing; the App Store version with "What's New", Apple's 7-day phased release, and the review submission. Google Play: production at 5% of users with the same notes.
  4. After approval: Google Play 5% → 20% → 50% → 100%, a day each when healthy; iOS follows Apple's phased release.

## How day2 judges a release

With its own field data (`field-store` `releaseHealth`): every launch reports a release tag — the store build and the update it runs, e.g. `1.4.1(24)@3f2a9c1e` (`releaseTag` in the native field library). The new release is compared with the one before it, same window (`mobile-release/health.ts`):

- **Regressed** when crashes are clearly up (≥ 95% posterior that the crash rate is worse, at least 3 crashes and +0.5 points), or a check fails on ≥ 3% of launches and far more than before.
- **Regressed →** an update is reverted for everyone (`eas update:revert-update-rollout`); an iOS phased release is paused; a Google Play rollout is halted. A priority bug ticket lists what was in the release; its fix ships as the next release.
- The owner can roll back / stop any release from the console.

## Where day2 stops for a person

- **Store privacy answers** out of date (App Store Connect and Play Console have no API day2 can use for them) — see `docs/store-privacy.md`.
- **Release notes**, only if the owner chose "I approve the notes" (default: day2 writes them from what changed and goes ahead).
- **App Review / Google Play rejections** — the reason is only in App Store Connect / Play Console.
- **Managed publishing** on Google Play — the owner clicks Publish.

## Setting an app up (once)

- **day2 does the code** (one ticket, `mobile-release/setup.ts`): expo-updates and expo-application, the fingerprint runtime policy and EAS Update URL, eas.json (remote versions, auto-increment, production channel, internal track), and the release tag in `startDay2`. That's a native change, so it reaches users with the next store release.
- **The owner connects, on Connect your stores** ([connect.md](connect.md); stored encrypted, `release_credentials`): an Expo robot token (pasted once; day2 finds the EAS project), an App Store Connect API key (Team key, App Manager; the `.p8` dropped in, Key ID read from its name), and Google Play by **Sign in with Google** — day2 creates the service account and key in the app's Google Cloud project and invites it in Play Console with release permissions (or the owner does that one invite, with the exact email and a Check button). Releases links there; its API (`PUT /api/apps/:id/mobile-releases/accounts/:kind`) still works. And once, on their computer: `eas build` for each platform, so EAS stores the signing credentials.
- **Turning it on** is the owner's choice (Releases → "Turn on releases by day2"); settings choose how far day2 goes by itself (updates, store builds, store release).

## What isn't verified yet

The adapters (`eas.ts`, `app-store.ts`, `play.ts`) follow eas-cli 27.2.0's source and Apple's and Google's current docs, call by call in tests, but haven't run against real accounts. Before relying on it, run one release of a test app through each path.
