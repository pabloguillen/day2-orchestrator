# Credits, backlog and app creation — operator notes

## Credits (src/credits.ts)

One balance per account, at a list value of €0.01 per credit. Plans:

| Plan | € / month | Credits / month | Apps | Seats |
|---|---|---|---|---|
| Trial (14 days) | 0 | 1,000 once | 1 | 1 |
| Starter | 29 | 3,000 | 1 | 1 |
| Growth | 79 | 8,500 | 3 | 3 |
| Scale | 199 | 22,000 | 10 | 10 |

Yearly billing takes 20% off. Unused monthly credits roll over one month.
Top-ups: 1,000 for €10 or 10,000 for €100, valid 12 months.

Hidden markups on day2's real cost (never sent to the console): agent work,
scans/answers and growth content 3.0×, Lovable builds 2.0×, hosting 1.5×,
paid ads 1.2× (ads convert at what the customer paid per credit, so
discounted credits are never sold below cost).

Every Claude agent run goes through `metered-query.ts`: it checks the worst
case (`maxBudgetUsd`) before starting and charges the real cost after.

Settings (environment):

- `DAY2_USD_TO_EUR` — rate used to convert provider costs (default 0.95).
- `DAY2_CREDITS=off` — development only: skip metering entirely.
- `DAY2_CREDITS_DIR` — where the ledger lives (default: next to `.day2-apps.json`).

No payment provider is connected yet: plan changes and top-ups are recorded
without charging a card, and the console says so.
`bun run credits plan scale` / `bun run credits grant 5000 "note"` for the operator.

## Backlog (src/backlog*.ts)

- `bun run backlog tick` — import findings (Sentry, health checks, day2
  proposals), re-rank, settle merged/closed PRs, sync JIRA/Linear, and start
  work within each app's limits. Run it on a schedule (e.g. every 15 minutes).
- `SENTRY_AUTH_TOKEN` is needed for Sentry; the org/project is set per app
  under Backlog → Rules & sources.
- JIRA/Linear tokens are entered per app in the console and stored in
  `.day2-integrations.json` (gitignored, never returned by the API).

## Create an app with Lovable (src/lovable.ts)

**Hidden for now** behind a server-side flag: every endpoint returns 404
and the console shows no entry point until `DAY2_FEATURE_CREATE_APPS=on`.
Lovable's docs cover their MCP server for each user's own account (that's
how their ChatGPT/Claude plugins work); turn this on once Lovable confirms
in writing that day2 may build apps for its customers on day2's account.

day2 uses its own Lovable account; customers never need one.

1. Connect it once: Apps → Create a new app → "Connect day2's Lovable
   account" (OAuth — what Lovable documents for its MCP server). Tokens are
   kept in `.day2-lovable.json` (gitignored).
   Alternatively set `DAY2_LOVABLE_API_KEY=lov_…`; it is sent as a
   `Lovable-API-Key` header. A third-party guide documents this for headless
   use, but Lovable's own docs only mention OAuth, so if the key is refused,
   use the OAuth connect.
2. If the account has more than one workspace, put `"workspaceId": "…"` in
   `.day2-lovable.json`.
3. Pricing inputs: `DAY2_LOVABLE_CREDITS_PER_BUILD` (Lovable credits a first
   build uses, default 5) and `DAY2_LOVABLE_USD_PER_CREDIT` (what day2 pays per
   Lovable credit, default 0.60). Lovable's tools don't report usage per build,
   so builds are charged at this estimate — compare with Lovable's invoice
   and adjust.
4. GitHub: the orchestrator uses the `gh` login of the account it runs
   under. Run `gh auth login` (GitHub.com → HTTPS → "Login with a web
   browser"), then `gh auth status` to check; the token needs the `repo`
   scope (the default). New app repos are private and created under that
   account, or under `DAY2_GITHUB_OWNER` (e.g. your organization) if set.
   Without a gh login the app stays a local repository.
5. Logo: Lovable's official logomark is at
   `console/public/brand/lovable-logo.png` (resized to 256 px).
