/**
 * W16b: rerun of W16's comparison test with one deliberate fix. The
 * original task said "delete each of them one at a time," which — by
 * design, not accident of the UI — meant the treatment condition's
 * `bulkActions: true` capability (checkbox-select + "Delete selected") was
 * never exercised by either condition. See docs/w16-swarm-comparison-
 * results.md's "A real flaw in this experiment's own design" section.
 *
 * The only change from w16-run-comparison.ts is the task wording: it no
 * longer specifies a deletion method at all, so whether a persona notices
 * and uses the bulk-select affordance (present only in the treatment
 * config: density="table", bulkActions=true) is now the thing being
 * measured, not something the task accidentally rules out. Everything else
 * (conditions, device-ID mechanics, metrics) is identical to W16 by
 * design — only one variable changed.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { runComparisonPersona } from "./swarm";

const PREVIEW_URL = "https://pabloguillen-expense-buddy.pablo-guillen.workers.dev";
const RUNS_PER_CONDITION = 3;

const TREATMENT_DEVICE_ID = process.argv[2];
if (!TREATMENT_DEVICE_ID) {
  console.error("Usage: bun run src/w16b-run-comparison.ts <pre-seeded-treatment-device-id>");
  process.exit(1);
}

const TASK = `Add 6 new expenses, spread across at least 3 different categories (use
whatever categories the form offers). Give each a short, realistic note.
Once all 6 are added, review your spending (look at whatever summary the
page shows). Then find the 3 oldest expenses you just added and remove
them from the list. Confirm the app's total/summary reflects the 3
remaining new expenses correctly afterward.`;

function freshControlId(): string {
  return `day2w16bctrl${randomBytes(6).toString("hex")}`;
}

async function main() {
  const auditPath = "w16b-comparison-results.jsonl";
  const all: Array<Awaited<ReturnType<typeof runComparisonPersona>>> = [];

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    const deviceId = freshControlId();
    console.log(`[w16b] control run ${i + 1}/${RUNS_PER_CONDITION} (device ${deviceId})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "control", deviceId, TASK);
    console.log(`[w16b] control run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    console.log(`[w16b] treatment run ${i + 1}/${RUNS_PER_CONDITION} (device ${TREATMENT_DEVICE_ID})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "treatment", TREATMENT_DEVICE_ID, TASK);
    console.log(`[w16b] treatment run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  writeFileSync("w16b-comparison-results-summary.json", JSON.stringify(all, null, 2));
  console.log(`[w16b] done. ${all.length} runs written to ${auditPath} and the summary JSON.`);
}

main();
