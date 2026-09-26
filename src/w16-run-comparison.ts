/**
 * One-off runner for W16's comparison test (COORDINATION.md, W16;
 * docs/w16-swarm-comparison-results.md has the actual results and honest
 * framing). Not a reusable CLI in the sense `canary-cli.ts`/`auto-release-
 * cli.ts` are — this is the script that produced one specific experiment's
 * data. `runComparisonPersona` (swarm.ts) is the reusable part.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { runComparisonPersona } from "./swarm";

const PREVIEW_URL = "https://pabloguillen-expense-buddy.pablo-guillen.workers.dev";
const RUNS_PER_CONDITION = 3;

// Pre-seeded once, outside this script, directly in DAY2_CONFIG KV — see
// docs/w16-swarm-comparison-results.md for the exact seeded value and how
// it was verified before any persona ran.
const TREATMENT_DEVICE_ID = process.argv[2];
if (!TREATMENT_DEVICE_ID) {
  console.error("Usage: bun run src/w16-run-comparison.ts <pre-seeded-treatment-device-id>");
  process.exit(1);
}

const TASK = `Add 6 new expenses, spread across at least 3 different categories (use
whatever categories the form offers). Give each a short, realistic note.
Once all 6 are added, review your spending (look at whatever summary the
page shows). Then find the 3 oldest expenses you just added (the ones
still at the bottom of the list, or however the page orders them) and
delete each of them one at a time. Confirm the app's total/summary
reflects the 3 remaining new expenses correctly afterward.`;

function freshControlId(): string {
  return `day2w16ctrl${randomBytes(6).toString("hex")}`;
}

async function main() {
  const auditPath = "w16-comparison-results.jsonl";
  const all: Array<Awaited<ReturnType<typeof runComparisonPersona>>> = [];

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    const deviceId = freshControlId();
    console.log(`[w16] control run ${i + 1}/${RUNS_PER_CONDITION} (device ${deviceId})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "control", deviceId, TASK);
    console.log(`[w16] control run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    console.log(`[w16] treatment run ${i + 1}/${RUNS_PER_CONDITION} (device ${TREATMENT_DEVICE_ID})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "treatment", TREATMENT_DEVICE_ID, TASK);
    console.log(`[w16] treatment run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  writeFileSync("w16-comparison-results-summary.json", JSON.stringify(all, null, 2));
  console.log(`[w16] done. ${all.length} runs written to ${auditPath} and the summary JSON.`);
}

main();
