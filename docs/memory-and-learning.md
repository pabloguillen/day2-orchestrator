# What day2 knows, and what works

Two things make day2 better the longer it works for you:

1. **What day2 knows** (app memory): what *you* told day2 about one app, kept as short notes every agent reads before it works on that app.
2. **What works** (learning across apps): anonymous results from every app day2 runs, so a new idea for your app can start from what worked for similar apps.

The first is private to your app. The second is shared — but only as anonymous numbers, never anything that identifies you or your users.

---

## 1. What day2 knows (one app)

### What is remembered

Short notes in plain words, each of one kind:

| Kind | Example |
|---|---|
| Rule | "Never change the sign-in screen without asking." |
| Don't | "Don't propose a lifetime plan." |
| Preference | "Push texts stay calm and short, no exclamation marks." |
| Who it's for | "Most users are nurses on night shifts." |
| Fact | "The app is free in schools; parents pay." |
| How it's built | "The app uses Expo Router and Zustand." |

Each note says where it came from (with a link to the ticket, pull request, page or proposal), who said it and when, how sure day2 is, and whether it's active, waiting for you to confirm, or retired.

### Where it comes from

day2's *memory keeper* reads what you and your team write and decide, and turns the parts worth keeping into notes:

- comments on tickets and pull requests, and questions you ask about a change;
- your answers to day2's questions, and what you ask for in **Tell day2**;
- **declines** — and the one short, optional question that comes with every Decline / Not now button: *Why not?*;
- your edits to texts day2 wrote (store texts, push and in-app texts, paywall wording, screenshot captions): day2 looks at what you changed and learns the preference behind it;
- notes you add when you approve something;
- your own backlog rules (copied in as rules, active at once).

The keeper runs at most once an hour per app, and right away after a decline with a reason or an answer to one of day2's questions. It's a small text-only run paid from your credits (Scans & answers).

Rules for what it keeps:

- **Never secrets or data about your users.** A strict filter removes keys, passwords, tokens (also unknown ones that look random, base64 included), email addresses (also "name [at] host [dot] com" and non-Latin ones), phone numbers, card numbers and IBANs, ids, and sentences like "Jane Miller complained…" — before the keeper reads your input, and again before a note, a proposal key or a decline target is saved. The keeper is told the same. One limit: a person's name on its own ("ask Jane about it") isn't reliably recognised, so the keeper is told never to keep names of users.
- **One decision is weak evidence.** A note read from a single decline or edit starts as *needs confirmation* and counts less.
- **What you write yourself is active at once** (your rules, notes you add on the page).
- **Newer wins.** When something new contradicts an older note, the new one replaces it and the page shows the change under *Recently updated*.

### Where it's used

One function, `memoryFor(app, purpose)` (`src/memory/runtime.ts`), gives each agent a compact block (at most about 1,500 tokens), ranked for the work at hand. It goes into:

- the build agent, its independent reviewer, the bug agent and its verifier;
- feature plans and **Tell day2**;
- day2's answers to your questions (on tickets, pull requests and *Ask*);
- Live experiment ideas, the Money plan, Store research and listing texts, Messages texts, retention research, and Create's screen list, design system and screens.

Each note shows when it last shaped a decision ("used for the store listing 2 days ago").

### The hard rule: no means no

When you decline something, day2 doesn't propose **the same kind of thing for the same target** again for 90 days — not as a request in a prompt, but as a check in code before any credits are spent:

- declines of Live ideas, Money plans, products and tests, store texts, screenshots, product page tests and custom pages, messages, retention treatments and tickets are recorded with their kind and target;
- a *Don't* note you confirmed blocks for as long as it's active; one day2 inferred blocks for 90 days;
- if you ask for it yourself (for example "Plan prices now"), the earlier decline doesn't stop you. A confirmed "never" rule still does — change it on the page if that's no longer true.

### How to correct it

Open **What day2 knows** in the app menu. There you can:

- confirm notes day2 read from one decision, fix their words, or retire them;
- edit or retire any note, and add your own;
- see what you said no to, and allow something again before the 90 days are over.

API: `GET /api/apps/:id/memory`, `POST …/memory/items`, `PATCH …/memory/items/:mid`, `POST …/memory/items/:mid/confirm|retire|restore`, `POST …/memory/declines/lift`, `POST …/memory/capture`.

Where it's stored: `day2-memory.json` in the app's folder (on your Mac), or the `memory_items` and `memory_state` tables (in the cloud, migration `022_memory.sql`).

---

## 2. What works (across apps)

### What is shared

Every time day2 decides a measured result, it can add one anonymous record to a library shared by all apps:

- Live experiment verdicts (and Money's price, trial, layout and ad tests, which run in Live);
- Messages campaigns measured against their holdouts;
- retention treatments measured against their holdouts;
- Store product page tests;
- ad experiments (bets);
- build failures and the fix that worked (the *build playbook*, below).

A record holds only:

- the **kind of app** (a category from a fixed list, a product type, the platform);
- the **kind of change** from a small fixed list (e.g. `paywall.trial_length`, `push.onboarding_d1`, `store.subtitle_benefit`, `ads.interstitial_frequency`, `onboarding.skip_signup`, `price.tier_change`) and a few abstract words ("free trial length: 7");
- the **metric**, the **relative effect** with an interval (+6%, between +2% and +10%), the size as a **bucket** ("1k–10k users"), the verdict and the day.

### What is never shared

No app names, no texts the app or you wrote, no user numbers, no revenue amounts, no ids. The words of a record are checked against your app's name, money amounts, quotes and the privacy filter; anything that doesn't pass is replaced by the kind's plain label. To count each app only once, the library keeps a salted hash of the app — it is never shown, not even to day2's operators, and can't be turned back into your app.

### How it's used

- **Ideas start from what worked.** Live, Money, Messages, Store, Retention and Create get a line like *"Free trial length: worked in 7 of 9 similar apps, typical +4% to +9% conversion"*. You see the same line next to ideas on those pages.
- **New apps start from the best-known defaults** for their category (trial length, how often ads show, when to ask for push permission or a rating) — always as Live settings tested against a control, never assumed.
- **Shorter experiments when the evidence is strong.** The result for similar apps goes into Live's Bayesian test as an informative prior, capped so it never weighs more than half of what the experiment's own minimum sample gives — your app's own users still decide. With a strong prior (most similar apps saw it help, from at least 5 apps), a test may decide with 60% of the usual users; guardrails (crashes, D7 retention) never use the prior.
- **Fewer repeated build failures.** Each failed build or check is reduced to a signature (framework version, package, error type). When a later run on the same ticket gets through, its fix — generalized, with no code, file paths, quotes or app name — becomes a playbook candidate. After an operator approves it, the build agent gets it as a note for apps on the same stack.
- **False-positive candidates.** The release check's calibration loop may suggest a new false-positive pattern; it never clears a release by itself, and goes to the operator for review (`src/false-positive-patterns.ts` itself only changes by hand).

A result is only shown once **at least 3 different apps with a measured effect, in at least 3 different accounts,** are behind it, and never with any result of your own account (all its apps are left out, not only the one asking) — so nobody can read one app's result back out of it, not even with several apps of their own. Both hashes (app and account) are salted and never shown.

### The maths, briefly

Per (category, kind of change): each app's results are pooled first, then a random-effects (partial-pooling) model combines apps — DerSimonian–Laird for how much apps differ, and weights by how similar each app's category is (own category 1, a related one less, an unrelated one least; changes whose effect hardly depends on the category transfer more). "Chance it helps" is the predictive probability for a new app like yours. Code: `src/learning/priors.ts`, tests with small worked examples in `src/learning/learning.test.ts`.

### Turning it off

It's on by default. Owners and admins can turn it off on **People & workspace** (or **Workspace** on your Mac) under *Learning across apps*. Off means day2 stops sharing your apps' results and removes everything already shared: the results, build failures waiting for a fix, and your apps on playbook entries (entries only your apps made are removed, unless an operator already approved them — then only your apps are taken off). Removing an app removes its results too. Your apps can still be shown what worked elsewhere.

Where it's stored: `day2-learning.json` in day2's data folder (on your Mac), or the `learning_*` tables (in the cloud, migration `023_learning.sql`). Operators see the library and review the playbook on **Platform → What works across apps** (`/operator/learning`).
