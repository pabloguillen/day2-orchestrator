# Field contracts: knowing a UI bug instead of guessing it

A field contract says what must be true in an app. A small library checks it on
users' devices and reports only when it breaks, as "expected X, actual Y" with
the evidence. Example:

> Tap "cart.continue" on /cart should lead to /checkout — stayed on /cart
> (POST /api/cart/validate → 500). 9 times on 7 devices. Steps: screen /cart →
> tap cart.continue → POST /api/cart/validate → 500. Seen on iOS Safari 390×844, de-DE.

That's a fact, not a heuristic. Rage taps and drop-off spikes stay hints.

## The parts

| Part | Where | What it does |
|---|---|---|
| Library | `packages/sensors` (`@day2/sensors`) | Runs in the app. Checks contracts, sends small JSON batches. About 7 KB gzipped, no dependencies. |
| Contract generator | `src/contracts-gen.ts` | Reads the app's code (TypeScript parser) and writes the contracts. |
| Ingest | `src/field-ingest.ts`, `POST /api/ingest/<key>` | Receives batches: validates, re-shapes, rate-limits, stores. |
| Store | `src/field-store.ts` | Postgres in production (`006_field_contracts.sql`), files locally. |
| Loops | `src/field-work.ts` | Broken contracts → tickets; install ticket; growth events; ads held for broken pages. |
| Console | Field checks page per app | What's broken, its ticket, what holds. |

## Contract families

| Family | Example | Where it comes from |
|---|---|---|
| Action | Tap "Continue" → `/checkout` within 3 s; "Pay" → `POST /api/orders` 2xx | The handler's code (`navigate`, `router.push`, `fetch`, axios, Supabase `.insert()` / `.rpc()`), or `day2.contracts.json` |
| Screen | `/checkout` shows `[data-day2-require="total"]` within 3 s | Routes from the code (TanStack Router, React Router, Next.js, Expo Router) |
| Speed | `/checkout` ready within 1 s; LCP 2.5 s; tap response 200 ms | Built in; tighter budgets in `day2.contracts.json` |
| Flow | Sign-up: `/signup` → `/signup/profile` → `/welcome` within 15 min | `day2.contracts.json` |
| Invariant | Receipt total = sum of items | The app's code: `day2.check("receipt.total", total === sum)` |
| Built in | No crash, error, freeze over 2 s, 5xx; links open their page; screens fit; no "undefined"/"NaN"; images load; loading ends within 10 s | Every app, no setup |

**Rejected input is not a bug.** A 4xx with a visible message (`role="alert"`,
`aria-invalid`, `data-day2-error`) is counted as "rejected input". A 4xx with no
message is a failure, because the app turned the user away without saying why.

## How it gets into an app

1. On each pass (every 15 minutes) day2 regenerates the app's contracts when its
   code changed, and serves them at `GET /api/ingest/<key>/contracts`.
2. If the app isn't reporting yet, day2 adds an **Install day2 field checks**
   ticket. When it runs, day2 places `day2/sensors.js` (+ `.d.ts`) in the working
   copy. The agent then:
   - adds the one-line `startDay2({ key, endpoint })` at startup;
   - tags the actions the generator couldn't locate (`data-day2-action`);
   - marks loading and error states;
   - wires `day2.track("signup" | "activated" | …)`;
   - adds a test showing day2 starts exactly once.

   The change goes through the app's normal approval.
3. Once live, reports arrive. Broken contracts become backlog bugs at 3 failures
   or 2 devices (a crash: at once). Each bug carries expected/actual, the steps,
   the devices and the code location. day2 reproduces it with a browser test
   first, then fixes it.

Web is supported now. React Native / Expo is next: the core (`packages/sensors/src/core.ts`)
is platform-neutral, so only a mobile adapter is needed.

## Self-distribution

- Growth events (`visit` with where the visitor came from, `signup`, `activated`,
  `shared`, `invite_sent`) come from the same library. Experiments and the
  before/after checks read them from the store. An app's own `/api/day2-events`
  endpoint is still used when the library isn't installed.
- No paid traffic to a broken page. Before launching an ad, and on every pass
  while it runs, day2 checks the page's contracts for the last day. A broken page
  holds its ad, and day2 turns it back on when the page works again.

## Privacy and safety

- **Identity:** an anonymous random id per browser session by default. `identity: "device"`
  keeps it across visits; turn that on only after consent where the law requires it (EU).
- **Never sent:** typed input, query strings, or ids in paths (`/orders/123` →
  `/orders/:id`). Labels have digits masked. No screen recording, no screenshots.
- **The key** is public: it can only send reports for one app, never read anything.
- **Ingest limits:**
  - batches up to 64 KB;
  - 120 per key and 300 per address per minute;
  - browser requests only from the app's own address (and localhost);
  - unknown fields dropped.
- **Retention:** failure reports 30 days, growth events 180 days, then deleted.
