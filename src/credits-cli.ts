import { getSummary, grantManual, setPlan, type BillingCycle, type PaidPlanId } from "./credits";
import { creditStore } from "./day2-paths";

/**
 * Operator tool for the account's credits (until a payment provider is
 * connected, this and the console are how plans and credits change).
 *
 *   bun run src/credits-cli.ts                       # balance
 *   bun run src/credits-cli.ts plan scale [yearly]   # change plan
 *   bun run src/credits-cli.ts grant 5000 "Beta"     # free credits (can't pay for ads)
 */
async function main(args: string[]): Promise<void> {
  const store = creditStore();
  const [cmd, a, b] = args;
  if (cmd === "plan") {
    const r = await setPlan(store, a as PaidPlanId, (b ?? "monthly") as BillingCycle);
    console.log(`Plan: ${r.summary.plan.name} (${r.effective === "now" ? "now" : "from next month"}).`);
  } else if (cmd === "grant") {
    const g = await grantManual(store, Number(a), b ?? "Credits added");
    console.log(`Added ${g.credits.toLocaleString("en-US")} credits (expire ${g.expiresAt.slice(0, 10)}).`);
  } else if (cmd !== undefined) {
    throw new Error(`Unknown command "${cmd}". Use: plan <starter|growth|scale> [monthly|yearly] | grant <credits> [note]`);
  }
  const s = await getSummary(store);
  console.log(
    `${s.plan.name} · ${s.balance.total.toLocaleString("en-US")} credits left ` +
      `(${s.balance.monthly.toLocaleString("en-US")} monthly, ${s.balance.topUp.toLocaleString("en-US")} top-up) · renews ${s.period.renewsAt.slice(0, 10)}`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
