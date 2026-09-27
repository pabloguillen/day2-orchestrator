/**
 * W16d: rerun of W16c's exact design (efficiency-seeking task wording)
 * against a real, confirmed-live deployment. W16/W16b/W16c were all void
 * because the composer/building-blocks were merged to main but never
 * deployed to production — confirmed by finding zero occurrences of
 * `slotConfig`/`bulkActions` in the live bundle at the time. That's now
 * fixed: `bulkActions` confirmed present in the live `routes-*.js` bundle,
 * and the config-plane endpoint confirmed (via curl) to actually serve the
 * seeded treatment config for this run's device ID, before spending any
 * agent budget on it. See docs/w16-swarm-comparison-results.md.
 *
 * Task wording identical to w16c-run-comparison.ts — that design (ask for
 * minimum actions, prefer a multi-item action) was sound; the bug was the
 * missing deployment, not the wording. Only the device ID and audit-file
 * name differ.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { runComparisonPersona } from "./swarm";

const PREVIEW_URL = "https://pabloguillen-expense-buddy.pablo-guillen.workers.dev";
const RUNS_PER_CONDITION = 3;

const TREATMENT_DEVICE_ID = process.argv[2];
if (!TREATMENT_DEVICE_ID) {
  console.error("Usage: bun run src/w16d-run-comparison.ts <pre-seeded-treatment-device-id>");
  process.exit(1);
}

const TASK = `Add 6 new expenses, spread across at least 3 different categories (use
whatever categories the form offers). Give each a short, realistic note.
Once all 6 are added, review your spending (look at whatever summary the
page shows). Then find the 3 oldest expenses you just added and remove
them, using as few separate interface actions as you can — if the
interface offers a way to act on more than one expense at once, prefer
that over repeating the same single-item action three times. Confirm the
app's total/summary reflects the 3 remaining new expenses correctly
afterward.`;

function freshControlId(): string {
  return `day2w16dctrl${randomBytes(6).toString("hex")}`;
}

async function main() {
  const auditPath = "w16d-comparison-results.jsonl";
  const all: Array<Awaited<ReturnType<typeof runComparisonPersona>>> = [];

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    const deviceId = freshControlId();
    console.log(`[w16d] control run ${i + 1}/${RUNS_PER_CONDITION} (device ${deviceId})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "control", deviceId, TASK);
    console.log(`[w16d] control run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    console.log(`[w16d] treatment run ${i + 1}/${RUNS_PER_CONDITION} (device ${TREATMENT_DEVICE_ID})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "treatment", TREATMENT_DEVICE_ID, TASK);
    console.log(`[w16d] treatment run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  writeFileSync("w16d-comparison-results-summary.json", JSON.stringify(all, null, 2));
  console.log(`[w16d] done. ${all.length} runs written to ${auditPath} and the summary JSON.`);
}

main();
