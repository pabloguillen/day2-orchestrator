# Device checks and mockups

day2 shows what a UI change looks like before it's built (a **mockup**). Before it opens a pull request, it runs the changed app on **virtual devices**. A crash, a failed flow or an app that doesn't start stops the change: there's no pull request, and the ticket says why.

## What happens to a change

For mobile apps (React Native / Expo), after the build agent finishes and the app's own tests pass:

1. **Is it a UI change?** Screens, components, assets, `app.json` / `app.config.*`, `eas.json`, `package.json`. Website files, backend code and tests alone skip the device check, and the ticket says so (`device-checks/plan.ts`).
2. **Build.** The change, and the commit it starts from, are each built for the iPhone Simulator (and the Android emulator when there is one). These are release builds with the JavaScript bundled in, so no dev server is needed. The "before" build is kept per commit, so it's built once (`device-checks/local.ts`, `targets.ts`).
   - The owner's `.env` files from the app's checkout go into the build's environment. The app gets the same `EXPO_PUBLIC_*` settings as the owner's own builds. Nothing is copied into the repo.
3. **Run.** It always starts from a clean install.
   - **With Maestro:** day2 runs every flow in `.maestro/`. The build agent writes `.maestro/day2/<ticket>.yaml` for the screens it changed, plus a `smoke.yaml`.
   - **Without Maestro:** day2 starts the app and checks it's still running after 8 and 15 seconds, with a screenshot each time.
   - Crash reports written during the run count as failures (iOS DiagnosticReports, Android's crash log).
4. **Screenshots** of every `takeScreenshot` step, before and after, paired by step name. They're kept on the day2 server (`<data dir>/device-checks/<app>/<branch>/`) and shown on **Approvals** and on the ticket. The pull request says the result and points there.

One check runs at a time, because the simulators are shared. The progress bar on the ticket reads "running it on virtual devices".

## Local mode (your Mac)

Where checks run is set by `DAY2_DEVICE_CHECKS`. On a Mac with Xcode, it's `local` by default.

- [ ] **Xcode with an iPhone simulator.** Xcode → Settings → Platforms → iOS. day2 uses a booted iPhone simulator if one is running, else the first iPhone on the newest iOS.
- [ ] **CocoaPods**, needed for Expo's iOS build: `brew install cocoapods`.
- [ ] **Maestro**, for the flows and step screenshots. It needs Java 17 or newer:
  ```bash
  brew install openjdk@17          # if `java -version` shows nothing or < 17
  curl -fsSL https://get.maestro.mobile.dev | bash
  ```
  Without it, day2 only starts the app and watches it. The report says so.
- [ ] **Optional: Android.** Android Studio with one virtual device (Device Manager). day2 starts the first emulator itself, without a window. Without one, Android is "not checked" and the report says so.
- **Signed-in screens.** Flows run as a signed-out user. If a change is behind sign-in, the flow covers what's reachable signed out, and the agent says so in its summary. Test accounts for flows aren't built yet.
- **Time.** Expect 5–15 minutes per build. The first "before" build of a commit is extra.

## Deployed (the cloud)

The server has no simulators. Set `DAY2_DEVICE_CHECKS=eas`.

1. **Expo account.** Each app's owner connects their Expo account on the **Releases** page. It's the same token releases use.
2. **The run.** day2 adds a build profile (`day2-device-checks`: an iOS simulator build and an Android APK) and a workflow file (`.eas/workflows/day2-device-checks.yml`) to the change's checkout. Then it runs `eas workflow:run --wait --json`, which builds and runs the app's Maestro flows on EAS's simulator and emulator (`device-checks/eas.ts`).
3. **Results.** Pass/fail comes back per platform, with a link to the run on expo.dev. Screenshots stay on expo.dev.
4. **Cost.** It uses the **app owner's EAS build minutes**.
5. **App settings.** `EXPO_PUBLIC_*` values come from the project's EAS environment variables, not from a local `.env`.

**Status: built, not verified end to end.** Run one change through it on a test project before relying on it.

## Mockups before work

For a ticket that changes a screen, day2 draws the screen as it will look. A read-only agent takes the app's colors, fonts, components and real texts from its code. It writes one phone-sized HTML page with what's new outlined in orange. That page is rendered to an image with every web request blocked (`mockups.ts`).

- It's drawn by itself together with every feature plan.
- On any open ticket: **Show me a mockup** / **Draw again**.
- Tickets that change no screen get a note instead of a picture.
- It costs a little in credits (at most about $0.80 per drawing).

It's a drawing in the app's style, not the app itself. The device-check screenshots show the real thing once it's built.

## Settings

| Setting | Values | Default |
|---|---|---|
| `DAY2_DEVICE_CHECKS` | `local`, `eas`, `off` | `local` on a Mac with Xcode, else `off` |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Android SDK folder | `~/Library/Android/sdk` |
