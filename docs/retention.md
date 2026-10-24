# Retention: keeping users, the way Duolingo does it

Duolingo's retention engine rests on two ideas:

1. **Every user is in exactly one state at any time.**
2. **Each state gets its own treatment.** The team works on whichever move between states loses the most users, chiefly the share of current users who come back.

day2 runs the same model for every app. The states and the measurement are the same for every app. What changes is the **rhythm**: "away for a while" means a day for a language app and weeks for a trip-splitting app. The **treatments** also change, and they come from what the leading apps in the same category verifiably do.

## The parts

| Part | Where | What it does |
|---|---|---|
| Lifecycle helpers | `packages/sensors/src/lifecycle.ts` | `stateOf`, `arm`, `hashUser`, `mayNudge`. The library, the app's own server and day2 all use the same code, so they agree. |
| Identity | `day2.identify(userId)` (web and React Native) | The app's user id, sent to day2 only as a hash salted with the app's key. From then on the library counts activity once a day. |
| Store | `src/field-store.ts`, `008_retention.sql` | Active days per user (kept 400 days) and first/last seen (kept 2 years). The latest snapshot per app. |
| Model | `src/retention.ts` | States, return rates, the biggest leak, research, treatment tickets, holdout measurement. |
| Pass | `src/retention-pass.ts`, called by the growth autopilot | Snapshot (every 6 hours), identify ticket, measure, research (every 60 days), next treatment. |
| API | `GET /api/apps/:id/growth/retention`, `POST …/retention/:ideaId/build` | The Retention tab. |
| Console | Growth → Retention | Return rate of current users, people per state, the leak, treatments with their measured effect, what's next. |

## States

The model has one state per user. Here "now" means the current period; "shortly before" and "a while" are the short and long windows in the rhythm table below.

| State | Meaning |
|---|---|
| New | First activity ever, this period |
| Current | Active now, and also shortly before |
| Reactivated | Active now, after a short break |
| Resurrected | Active now, after a long break |
| At risk | Not active now, but active shortly before |
| Lapsing | Not active recently, but within the long window |
| Dormant | Away longer than the long window |

| Rhythm | Now | Shortly before | A while | Typical products |
|---|---|---|---|---|
| Daily | 1 day | 7 days | 30 days | Habits: learning, fitness, games |
| Weekly | 7 days | 28 days | 90 days | Routines, work tools |
| Monthly | 30 days | 90 days | 180 days | Episodic (trips, bills), transactional (shops) |

**How day2 picks the rhythm:**
1. From usage: the median gap between active days, among users with 3 or more active days in the last 120 days. It needs at least 20 such users.
2. Otherwise from the product type, which the research step determines.
3. Otherwise weekly.

**Return rate:** of the users in a state at the start of the last full period, the share who were active during it. The rate for current users is Duolingo's CURR.

**Users lost:** users in the state × (1 − return rate). The state that lost the most users is the **leak**, and it is worked on first.

## Treatments

### Research

Every 60 days, an agent names the app's category and product type: habit, routine, episodic, work or transactional. It then researches how the 3–5 leading apps keep users in each state, and proposes at most 2 treatments per state for this app. Each treatment is in the app, by email or by push.

- Every proposal cites a real source. Uncited ones are dropped.
- A playbook per product type guides the research. For example: no streaks for an app used monthly, no generic discounts, never shaming.
- The agent sees the app's existing reminder and email code, and the senders the app already uses (Expo notifications, Resend, …).

### Build

The state losing the most users gets one treatment at a time, as a normal ticket that follows the app's autonomy level. The ticket:
- names the state;
- describes what the leaders do, with sources;
- gives the concrete change for this app;
- states the rules below.

The treatment lives in the app's own code. It uses the app's own users, consent and senders. day2 places `day2/lifecycle.js` in the app (under `src/` when there is one) so the app decides states exactly as day2 does.

### Rules every treatment follows

- **Holdout.** 10% of users never get it.
  - On the device: `day2.treatment("<id>") === "on"`.
  - On the server: `arm(hashUser(KEY, userId), "<id>") === "on"`.

  The decision depends only on the hashed id, so it is identical everywhere with no network call.
- **Reminders stop when ignored.** Before any push or email, the app checks `mayNudge(...)`. It allows at most one per period and none after 3 unanswered since the user was last active. The user's next activity resets it. This is Duolingo's lesson that reminders nobody answers teach people to turn them all off.
- Reminders also respect the user's notification and email consent and their unsubscribe.

### Measure

The measurement is a controlled test, using intention to treat.

1. After the treatment ships, every user who enters its state counts once, at the first period boundary where they're in it.
2. The user's arm comes from their hashed id. The outcome is whether they are active in the next period.
3. day2 needs to know only the arm, not whether the user saw the treatment, so the app doesn't have to report exposure.
4. With 30 or more users in each arm (the holdout and the treated users), day2 compares the two with the same Bayesian proportion test it uses for experiments:
   - **better** at 90% or more probability;
   - **worse** at 10% or less, and a ticket to remove the treatment is created;
   - otherwise **no clear change**.
5. A state with a treatment still being measured waits for its verdict before it gets another one.

## Privacy

- day2 only ever sees `u_` + 32 hex characters: the user id hashed with the app's key. The same person can't be linked across apps.
- Ingest drops anything that isn't such a hash.
- No email, name or raw id ever reaches day2. Contact details and consent stay in the app.
- The hashed id is still pseudonymous personal data. Apps call `identify` only after consent where their markets require it, which the identify ticket says.
- Retention periods:
  - active days: 400 days;
  - first and last seen: 2 years;
  - events: 180 days, as before.

## How it gets into an app

- **New installs:** the field-checks install ticket includes `day2.identify` on sign-in, session restore and sign-out.
- **Apps already reporting without identified users:** they get a **Let day2 see who comes back** ticket.
- After that, everything runs on the growth autopilot's timer. The owner can also build a researched treatment on request from the Retention tab when the autopilot is off.
