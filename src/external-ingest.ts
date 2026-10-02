import { existsSync, readFileSync } from "node:fs";

/**
 * External ingest (docs/closed-loop-spec.md §2.3, M1's "External ingest for
 * one ad platform + payments"). Real, pluggable adapters — every ingest row
 * maps to an `armId` where the source exposes campaign IDs, unmappable rows
 * go to `armId = "unattributed"` (spec §2.3), so the metric layer (M2) and
 * allocator (M3) can join spend/revenue back to real arms without a second
 * attribution mechanism.
 *
 * Honesty note, matching `growth-tools-config.ts`'s own precedent exactly
 * ("ships with `bindings: []` by default... an unresolved capability fails
 * closed"): this project has no real ad-platform or payment-provider
 * credentials — expense-buddy has zero billing code (confirmed repeatedly
 * across `docs/step4-self-distributing-plan.md` and `growth-strategy.ts`'s
 * own `unlockBasis` honesty check) and no ad account exists to poll. The
 * one adapter that's genuinely live-testable without any paid account or
 * API key is CSV import — every real ad platform and payment processor
 * supports a CSV/manual export, so this is a real, usable ingest path
 * today, not a placeholder. The named platform adapters (Meta Ads, Stripe)
 * are real, typed interfaces that fail closed to `not_configured` until an
 * operator supplies real API credentials — never fabricate a live call.
 */

export type SpendIngestRow = {
  armId: string;
  date: string; // ISO date (YYYY-MM-DD)
  spendUsd: number;
  impressions: number;
  clicks: number;
  installs?: number;
};

export type PaymentIngestRow = {
  date: string; // ISO date (YYYY-MM-DD)
  revenueUsd: number;
  refundsUsd: number;
  chargebacksUsd: number;
  /** Present only when the payment provider can attribute to a specific
   * device/user — absent rows still contribute to app-wide revenue totals
   * (M2's metric layer) but can't join into a specific cohort. */
  deviceOrUserId?: string;
};

export type IngestResult<Row> =
  | { status: "ingested"; source: string; rows: Row[]; unattributedCount: number }
  | { status: "not_configured"; source: string; reason: string }
  | { status: "parse_failed"; source: string; reason: string; lineNumber?: number };

const UNATTRIBUTED_ARM_ID = "unattributed";

// ---------------------------------------------------------------------------
// CSV adapter — real, live-testable without any paid account (spec §2.3)
// ---------------------------------------------------------------------------

/** Header a real ad-platform CSV export must have, in any column order.
 * `arm_id` is optional per row — a blank/missing value maps to
 * `UNATTRIBUTED_ARM_ID` rather than rejecting the row, matching the spec's
 * own "unmappable rows go to arm_id = 'unattributed'" rule. */
const SPEND_CSV_REQUIRED_COLUMNS = ["date", "spend_usd", "impressions", "clicks"] as const;
const SPEND_CSV_OPTIONAL_COLUMNS = ["arm_id", "installs"] as const;

const PAYMENT_CSV_REQUIRED_COLUMNS = ["date", "revenue_usd", "refunds_usd", "chargebacks_usd"] as const;
const PAYMENT_CSV_OPTIONAL_COLUMNS = ["device_or_user_id"] as const;

function parseCsv(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0]!.split(",").map((c) => c.trim());
  const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.trim()));
  return { header, rows };
}

function requireColumns(header: string[], required: readonly string[]): string | null {
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) return `missing required column(s): ${missing.join(", ")}`;
  return null;
}

function parsePositiveNumber(raw: string | undefined, field: string, lineNumber: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || Number.isNaN(n) || n < 0) {
    throw { field, lineNumber, message: `"${field}" must be a non-negative number, got "${raw}"` };
  }
  return n;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(raw: string | undefined, lineNumber: number): string {
  if (!raw || !ISO_DATE_PATTERN.test(raw)) {
    throw { field: "date", lineNumber, message: `"date" must be YYYY-MM-DD, got "${raw}"` };
  }
  return raw;
}

/** Pure — parses real CSV text into `SpendIngestRow[]`. This is the
 * genuinely live-testable path: no network call, no credentials, works
 * against a real export from any ad platform today. */
export function ingestSpendCsv(csv: string, sourceName = "csv"): IngestResult<SpendIngestRow> {
  const { header, rows } = parseCsv(csv);
  if (header.length === 0) {
    return { status: "parse_failed", source: sourceName, reason: "empty CSV" };
  }
  const missing = requireColumns(header, SPEND_CSV_REQUIRED_COLUMNS);
  if (missing) return { status: "parse_failed", source: sourceName, reason: missing };

  const col = (name: string) => header.indexOf(name);
  const hasArmId = SPEND_CSV_OPTIONAL_COLUMNS.includes("arm_id") && col("arm_id") !== -1;
  const hasInstalls = col("installs") !== -1;

  const result: SpendIngestRow[] = [];
  let unattributedCount = 0;
  try {
    rows.forEach((cells, i) => {
      const lineNumber = i + 2; // +1 for header, +1 for 1-indexing
      const armIdRaw = hasArmId ? cells[col("arm_id")] : undefined;
      const armId = armIdRaw && armIdRaw.length > 0 ? armIdRaw : UNATTRIBUTED_ARM_ID;
      if (armId === UNATTRIBUTED_ARM_ID) unattributedCount++;
      result.push({
        armId,
        date: parseIsoDate(cells[col("date")], lineNumber),
        spendUsd: parsePositiveNumber(cells[col("spend_usd")], "spend_usd", lineNumber),
        impressions: parsePositiveNumber(cells[col("impressions")], "impressions", lineNumber),
        clicks: parsePositiveNumber(cells[col("clicks")], "clicks", lineNumber),
        ...(hasInstalls ? { installs: parsePositiveNumber(cells[col("installs")], "installs", lineNumber) } : {}),
      });
    });
  } catch (err) {
    const e = err as { field: string; lineNumber: number; message: string };
    return { status: "parse_failed", source: sourceName, reason: e.message, lineNumber: e.lineNumber };
  }
  return { status: "ingested", source: sourceName, rows: result, unattributedCount };
}

/** Pure — same shape for payments CSV exports (Stripe, etc. all support
 * this format in practice). No `arm_id` concept for payments — cohort
 * attribution for revenue happens by joining `deviceOrUserId` back to the
 * acquisition event, not by a column in the payment export itself. */
export function ingestPaymentCsv(csv: string, sourceName = "csv"): IngestResult<PaymentIngestRow> {
  const { header, rows } = parseCsv(csv);
  if (header.length === 0) {
    return { status: "parse_failed", source: sourceName, reason: "empty CSV" };
  }
  const missing = requireColumns(header, PAYMENT_CSV_REQUIRED_COLUMNS);
  if (missing) return { status: "parse_failed", source: sourceName, reason: missing };

  const col = (name: string) => header.indexOf(name);
  const hasDeviceOrUserId = PAYMENT_CSV_OPTIONAL_COLUMNS.includes("device_or_user_id") && col("device_or_user_id") !== -1;

  const result: PaymentIngestRow[] = [];
  try {
    rows.forEach((cells, i) => {
      const lineNumber = i + 2;
      const deviceOrUserId = hasDeviceOrUserId ? cells[col("device_or_user_id")] : undefined;
      result.push({
        date: parseIsoDate(cells[col("date")], lineNumber),
        revenueUsd: parsePositiveNumber(cells[col("revenue_usd")], "revenue_usd", lineNumber),
        refundsUsd: parsePositiveNumber(cells[col("refunds_usd")], "refunds_usd", lineNumber),
        chargebacksUsd: parsePositiveNumber(cells[col("chargebacks_usd")], "chargebacks_usd", lineNumber),
        ...(deviceOrUserId ? { deviceOrUserId } : {}),
      });
    });
  } catch (err) {
    const e = err as { field: string; lineNumber: number; message: string };
    return { status: "parse_failed", source: sourceName, reason: e.message, lineNumber: e.lineNumber };
  }
  return { status: "ingested", source: sourceName, rows: result, unattributedCount: 0 };
}

/** Thin file-I/O wrapper, same "pure core, thin wrapper" split as every
 * other file-backed component in this project. */
export function ingestSpendCsvFile(path: string): IngestResult<SpendIngestRow> {
  if (!existsSync(path)) {
    return { status: "parse_failed", source: path, reason: `file not found: ${path}` };
  }
  return ingestSpendCsv(readFileSync(path, "utf-8"), path);
}

export function ingestPaymentCsvFile(path: string): IngestResult<PaymentIngestRow> {
  if (!existsSync(path)) {
    return { status: "parse_failed", source: path, reason: `file not found: ${path}` };
  }
  return ingestPaymentCsv(readFileSync(path, "utf-8"), path);
}

// ---------------------------------------------------------------------------
// Named platform adapters — real typed interface, fail closed until an
// operator supplies real credentials (none exist in this project today).
// ---------------------------------------------------------------------------

export type NamedAdPlatform = "meta_ads" | "google_ads" | "tiktok_ads";
export type NamedPaymentProvider = "stripe" | "apple_iap" | "google_play_billing";

/** Real env-var names an operator would set — checked, never hardcoded
 * credentials, never a silent fallback to a fabricated response. Matches
 * `growth-tools-config.ts`'s own "fails closed unset" discipline for
 * identity-bearing bindings. */
const AD_PLATFORM_ENV_VARS: Record<NamedAdPlatform, string> = {
  meta_ads: "DAY2_META_ADS_ACCESS_TOKEN",
  google_ads: "DAY2_GOOGLE_ADS_REFRESH_TOKEN",
  tiktok_ads: "DAY2_TIKTOK_ADS_ACCESS_TOKEN",
};
const PAYMENT_PROVIDER_ENV_VARS: Record<NamedPaymentProvider, string> = {
  stripe: "DAY2_STRIPE_SECRET_KEY",
  apple_iap: "DAY2_APPLE_IAP_SHARED_SECRET",
  google_play_billing: "DAY2_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
};

/** Real, reachable code path — not implemented in this pass (no credentials
 * exist to call anything real with), and honestly reports that rather than
 * faking a result, same posture `growth-execution.ts::performLiveAction`
 * already established for real MCP tool calls. */
export async function ingestFromAdPlatform(
  platform: NamedAdPlatform,
  _dateRange: { startDate: string; endDate: string },
): Promise<IngestResult<SpendIngestRow>> {
  const envVar = AD_PLATFORM_ENV_VARS[platform];
  if (!process.env[envVar]) {
    return {
      status: "not_configured",
      source: platform,
      reason: `${envVar} is not set — no day2-platform credential configured for ${platform}. Use ingestSpendCsvFile() with a real CSV export in the meantime.`,
    };
  }
  return {
    status: "parse_failed",
    source: platform,
    reason: `${platform}'s live API integration is not implemented in this pass — credential is present but no real API call is wired up yet.`,
  };
}

export async function ingestFromPaymentProvider(
  provider: NamedPaymentProvider,
  _dateRange: { startDate: string; endDate: string },
): Promise<IngestResult<PaymentIngestRow>> {
  const envVar = PAYMENT_PROVIDER_ENV_VARS[provider];
  if (!process.env[envVar]) {
    return {
      status: "not_configured",
      source: provider,
      reason: `${envVar} is not set — no day2-platform credential configured for ${provider}. Use ingestPaymentCsvFile() with a real CSV export in the meantime.`,
    };
  }
  return {
    status: "parse_failed",
    source: provider,
    reason: `${provider}'s live API integration is not implemented in this pass — credential is present but no real API call is wired up yet.`,
  };
}
