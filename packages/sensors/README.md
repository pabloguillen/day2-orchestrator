# @day2/sensors

day2's field contracts for web, React Native and Expo apps: checks on the user's device that what
should happen did happen, and reports "expected X, actual Y" when it didn't.

```ts
import { startDay2 } from "@day2/sensors";

export const day2 = startDay2({ key: "d2k_…", endpoint: "https://day2.example", release: "1.4.0" });

day2.track("signup");                          // growth events
day2.check("receipt.total", total === sum);     // invariants from your code
day2.identify(user.id);                         // who comes back (day2 gets a salted hash only); null on sign-out
if (day2.treatment("back-welcome") === "on") …  // retention treatments, 10% held out to measure them
```

- About 9 KB gzipped, no dependencies, safe to call during server rendering (does nothing there).
- Contracts come from day2 (generated from your code) and from `contracts` passed in.
- Tag elements day2 should check: `data-day2-action="cart.continue"`; required parts of a screen: `data-day2-require="total"`.
- Mark loading with `aria-busy="true"` and input errors with `role="alert"`.

React Native / Expo (`@day2/sensors/native`, react and react-native as peers):

```tsx
import { startDay2, useDay2Mark } from "@day2/sensors/native";
export const day2 = startDay2({ key: "d2k_…", endpoint: "https://day2.example" });

<NavigationContainer ref={ref} onReady={() => day2.trackNavigation(ref)}>  // or day2.route(pathname)
<Pressable onPress={day2.action("cart.continue", onContinue)}>
<Text {...useDay2Mark("total")}>…</Text>
```

On the app's server, `@day2/sensors/lifecycle` gives the same `stateOf`, `arm`, `hashUser` and `mayNudge` (reminder limits) — see `docs/retention.md`.

See `docs/field-contracts.md` in the orchestrator for the full picture.

`bun run build` writes `dist/`. Tests: `bun test` (the browser tests need a Chromium).
