# @day2/sensors

day2's field contracts for web apps: checks on the user's device that what
should happen did happen, and reports "expected X, actual Y" when it didn't.

```ts
import { startDay2 } from "@day2/sensors";

export const day2 = startDay2({ key: "d2k_…", endpoint: "https://day2.example", release: "1.4.0" });

day2.track("signup");                          // growth events
day2.check("receipt.total", total === sum);     // invariants from your code
```

- About 7 KB gzipped, no dependencies, safe to call during server rendering (does nothing there).
- Contracts come from day2 (generated from your code) and from `contracts` passed in.
- Tag elements day2 should check: `data-day2-action="cart.continue"`; required parts of a screen: `data-day2-require="total"`.
- Mark loading with `aria-busy="true"` and input errors with `role="alert"`.

See `docs/field-contracts.md` in the orchestrator for the full picture.

`bun run build` writes `dist/`. Tests: `bun test` (the browser tests need a Chromium).
