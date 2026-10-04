import { readFileSync } from "node:fs";
import { deriveWinbackSegment, renderChurnRiskSegment } from "./growth-winback";

/**
 * CLI for Step 4's retention/win-back segment deriver (growth-winback.ts) —
 * previously a real, fully unit-tested (at the parser level) function with
 * zero caller anywhere in the codebase.
 *
 * `deriveWinbackSegment` needs a real `atRiskDeviceIds` list as input —
 * deliberately NOT computed anywhere in this codebase (see
 * `growth-winback.ts`'s own file header: no "days since last session"
 * field is confirmed to exist on the real per-device profile endpoint, and
 * guessing at one would mean inventing a churn signal this project can't
 * actually verify). This CLI does not invent one either — it mirrors
 * `evolution-cli.ts`'s own `--device-ids` manual-input convention exactly
 * (a comma-separated list, trimmed), and adds `--device-ids-file` as a
 * real alternative for an operator-maintained list too long to comfortably
 * pass inline: one device ID per line, blank lines and `#`-prefixed
 * comments ignored.
 *
 * Usage:
 *   bun run src/growth-winback-cli.ts --app-url <url> --device-ids a,b,c
 *   bun run src/growth-winback-cli.ts --app-url <url> --device-ids-file <path>
 */

export function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  return {
    appUrl: get("--app-url"),
    deviceIds: get("--device-ids"),
    deviceIdsFile: get("--device-ids-file"),
  };
}

/**
 * Pure(ish) — the one real piece of logic this thin CLI owns (every other
 * decision lives in `growth-winback.ts` itself, already unit-tested there).
 * `--device-ids-file` wins when both are given — a real, maintained file is
 * a stronger source of truth than whatever happened to be typed inline
 * alongside it. Fails closed with a descriptive error rather than silently
 * running against an empty segment: a file that exists but yields no real
 * IDs (blank/comments only) is indistinguishable from "nothing at risk"
 * unless this throws, same "refuse to guess" discipline as every other
 * loader in this codebase.
 */
export function resolveAtRiskDeviceIds(opts: { deviceIds?: string; deviceIdsFile?: string }): string[] {
  if (opts.deviceIdsFile) {
    const raw = readFileSync(opts.deviceIdsFile, "utf-8");
    const ids = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (ids.length === 0) {
      throw new Error(
        `${opts.deviceIdsFile} exists but contains no real device IDs (blank lines/comments only) — refusing to run against an empty segment.`,
      );
    }
    return ids;
  }
  if (opts.deviceIds) {
    return opts.deviceIds.split(",").map((id) => id.trim()).filter(Boolean);
  }
  throw new Error("Either --device-ids or --device-ids-file is required.");
}

function usage(): never {
  console.error(
    "Usage: bun run src/growth-winback-cli.ts --app-url <url> --device-ids a,b,c\n" +
      "       bun run src/growth-winback-cli.ts --app-url <url> --device-ids-file <path>",
  );
  process.exit(1);
}

async function main() {
  const opts = parseArgs();
  if (!opts.appUrl) usage();

  let deviceIds: string[];
  try {
    deviceIds = resolveAtRiskDeviceIds(opts);
  } catch (err) {
    console.error(`[day2-winback] ${(err as Error).message}`);
    process.exit(1);
  }

  const segment = await deriveWinbackSegment(opts.appUrl, deviceIds);
  if (!segment) {
    console.log(
      "[day2-winback] No real shared pattern found across these device IDs — not a failure, just nothing honest to campaign against yet.",
    );
    return;
  }

  console.log(renderChurnRiskSegment(segment));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[day2-winback] Fatal error:", err);
    process.exit(1);
  });
}
