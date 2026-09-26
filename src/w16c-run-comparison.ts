/**
 * W16c: second rerun of the comparison test. W16b removed "one at a time"
 * from the task wording but that alone didn't cause the persona to
 * discover or use the treatment condition's bulk-select affordance — every
 * run in W16b still did individual deletes (see docs/w16-swarm-comparison-
 * results.md's W16b section). This round explicitly asks for efficiency
 * ("using as few interface actions as you can... prefer that over
 * repeating the same single action") rather than relying on spontaneous
 * discovery. This is a different, more directive experimental design than
 * W16/W16b on purpose — it tests "does bulk-select help once a user is
 * motivated to find it," not "do users stumble onto it unprompted." Both
 * are valid questions; this one is the one actually asked for. Same
 * conditions, device-ID mechanics, metrics, and treatment config as
 * W16/W16b — only the deletion-step wording changed again.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { runComparisonPersona } from "./swarm";

const PREVIEW_URL = "https://pabloguillen-expense-buddy.pablo-guillen.workers.dev";
const RUNS_PER_CONDITION = 3;

const TREATMENT_DEVICE_ID = process.argv[2];
if (!TREATMENT_DEVICE_ID) {
  console.error("Usage: bun run src/w16c-run-comparison.ts <pre-seeded-treatment-device-id>");
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
  return `day2w16cctrl${randomBytes(6).toString("hex")}`;
}

async function main() {
  const auditPath = "w16c-comparison-results.jsonl";
  const all: Array<Awaited<ReturnType<typeof runComparisonPersona>>> = [];

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    const deviceId = freshControlId();
    console.log(`[w16c] control run ${i + 1}/${RUNS_PER_CONDITION} (device ${deviceId})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "control", deviceId, TASK);
    console.log(`[w16c] control run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  for (let i = 0; i < RUNS_PER_CONDITION; i++) {
    console.log(`[w16c] treatment run ${i + 1}/${RUNS_PER_CONDITION} (device ${TREATMENT_DEVICE_ID})...`);
    const result = await runComparisonPersona(PREVIEW_URL, "treatment", TREATMENT_DEVICE_ID, TASK);
    console.log(`[w16c] treatment run ${i + 1} done:`, result);
    all.push(result);
    appendFileSync(auditPath, `${JSON.stringify(result)}\n`);
  }

  writeFileSync("w16c-comparison-results-summary.json", JSON.stringify(all, null, 2));
  console.log(`[w16c] done. ${all.length} runs written to ${auditPath} and the summary JSON.`);
}

main();
