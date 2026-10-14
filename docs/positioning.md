# What day2 is and what sets it apart

**day2 is the growth engineer for your app.** It fixes what leaks, builds
growth into the product, and only spends on what's proven to work.

Most AI growth tools (Holo, Arcads, Runway Ads, Lapis, AdsGency, Mokko) make
or run **ads** and judge them on the ad platform. day2 works **on the app
itself**. It has the code and the app's real usage, so it can do what they
can't:

1. **Fix what leaks.** Bugs and drop-offs get fixed first. Buying users for
   an app that loses them is wasted money. (Backlog, health checks, PRs.)
2. **Build what spreads.** Link previews, share and invite flows, pages people
   search for, and findability by AI assistants all live in the code. day2
   checks the app for each and builds what's missing as a PR, then makes the
   ones it has as good as the leading apps in its category do them, and
   checks each change before/after. (`distribution-loops.ts`,
   `growth-optimizer.ts`, Growth → Built into your app.)
3. **Pay only for what works.** Paid ads stay off until people stick around
   (stage gate, `growth-strategy.ts`). Every idea is an experiment from the ad
   to the product: its page in the app, a tracked link, and a verdict from
   real sign-ups and activation (`growth-bets.ts`, docs/growth-events.md).
4. **Use the best tools instead of rebuilding them.** Foreplay (competitor
   ads), Runway (video) and Meta Ads, through their official MCP servers, on
   day2's own accounts (`connectors.ts`, Tools). Customers connect nothing;
   use is billed in credits (`tool-pricing.ts`). day2 decides what to make and
   judges whether it worked.
5. **It runs itself.** The growth autopilot (`growth-autopilot.ts`) builds,
   researches, experiments and runs ads on a timer — no one has to click.
6. **Hands-off, not out of control.** Spend caps per app, a kill switch that
   pauses ads too, the app's autonomy level for shipping code, an off switch
   for the autopilot, and every action logged in plain words.

Customer: people who built an app (often with Lovable, Bolt, Replit or by
hand) and have no growth team.
