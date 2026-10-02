import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestFromAdPlatform,
  ingestFromPaymentProvider,
  ingestPaymentCsv,
  ingestPaymentCsvFile,
  ingestSpendCsv,
  ingestSpendCsvFile,
} from "./external-ingest";

describe("ingestSpendCsv — pure", () => {
  test("parses a well-formed real ad-platform export with arm_id and installs", () => {
    const csv = `date,arm_id,spend_usd,impressions,clicks,installs
2026-09-01,social_content|video|ugc|angle-1,42.50,1000,25,3
2026-09-02,social_content|video|ugc|angle-1,38.00,900,20,2`;
    const result = ingestSpendCsv(csv, "meta_ads_export.csv");
    expect(result.status).toBe("ingested");
    if (result.status !== "ingested") throw new Error("expected ingested");
    expect(result.rows).toEqual([
      { armId: "social_content|video|ugc|angle-1", date: "2026-09-01", spendUsd: 42.5, impressions: 1000, clicks: 25, installs: 3 },
      { armId: "social_content|video|ugc|angle-1", date: "2026-09-02", spendUsd: 38, impressions: 900, clicks: 20, installs: 2 },
    ]);
    expect(result.unattributedCount).toBe(0);
  });

  test("a row with no arm_id maps to 'unattributed', per spec §2.3, not rejected", () => {
    const csv = `date,spend_usd,impressions,clicks
2026-09-01,10,500,5`;
    const result = ingestSpendCsv(csv);
    expect(result.status).toBe("ingested");
    if (result.status !== "ingested") throw new Error("expected ingested");
    expect(result.rows[0]!.armId).toBe("unattributed");
    expect(result.unattributedCount).toBe(1);
  });

  test("a blank arm_id cell also maps to unattributed", () => {
    const csv = `date,arm_id,spend_usd,impressions,clicks
2026-09-01,,10,500,5`;
    const result = ingestSpendCsv(csv);
    if (result.status !== "ingested") throw new Error("expected ingested");
    expect(result.rows[0]!.armId).toBe("unattributed");
  });

  test("rejects a CSV missing a required column", () => {
    const csv = `date,spend_usd,impressions
2026-09-01,10,500`;
    const result = ingestSpendCsv(csv);
    expect(result.status).toBe("parse_failed");
    if (result.status !== "parse_failed") throw new Error("expected parse_failed");
    expect(result.reason).toContain("clicks");
  });

  test("rejects a malformed date with the real offending line number", () => {
    const csv = `date,spend_usd,impressions,clicks
2026-09-01,10,500,5
09/02/2026,20,400,4`;
    const result = ingestSpendCsv(csv);
    expect(result.status).toBe("parse_failed");
    if (result.status !== "parse_failed") throw new Error("expected parse_failed");
    expect(result.lineNumber).toBe(3);
  });

  test("rejects a negative spend value", () => {
    const csv = `date,spend_usd,impressions,clicks
2026-09-01,-5,500,5`;
    const result = ingestSpendCsv(csv);
    expect(result.status).toBe("parse_failed");
  });

  test("empty CSV fails closed, not an empty-but-successful result", () => {
    expect(ingestSpendCsv("").status).toBe("parse_failed");
  });
});

describe("ingestPaymentCsv — pure", () => {
  test("parses a well-formed payment export with device_or_user_id", () => {
    const csv = `date,revenue_usd,refunds_usd,chargebacks_usd,device_or_user_id
2026-09-01,9.99,0,0,device-abc123`;
    const result = ingestPaymentCsv(csv, "stripe_export.csv");
    expect(result.status).toBe("ingested");
    if (result.status !== "ingested") throw new Error("expected ingested");
    expect(result.rows).toEqual([
      { date: "2026-09-01", revenueUsd: 9.99, refundsUsd: 0, chargebacksUsd: 0, deviceOrUserId: "device-abc123" },
    ]);
  });

  test("device_or_user_id is optional — app-wide revenue still ingests without it", () => {
    const csv = `date,revenue_usd,refunds_usd,chargebacks_usd
2026-09-01,9.99,0,0`;
    const result = ingestPaymentCsv(csv);
    expect(result.status).toBe("ingested");
    if (result.status !== "ingested") throw new Error("expected ingested");
    expect(result.rows[0]!.deviceOrUserId).toBeUndefined();
  });

  test("rejects a missing required column", () => {
    const csv = `date,revenue_usd,refunds_usd
2026-09-01,9.99,0`;
    expect(ingestPaymentCsv(csv).status).toBe("parse_failed");
  });
});

describe("file wrappers — real filesystem round-trip", () => {
  test("ingestSpendCsvFile reads a real file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-ingest-"));
    try {
      const path = join(dir, "spend.csv");
      writeFileSync(path, "date,spend_usd,impressions,clicks\n2026-09-01,10,500,5\n");
      const result = ingestSpendCsvFile(path);
      expect(result.status).toBe("ingested");
      expect(result.source).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ingestSpendCsvFile fails closed (not silently empty) for a missing file", () => {
    const result = ingestSpendCsvFile("/nonexistent/path/spend.csv");
    expect(result.status).toBe("parse_failed");
  });

  test("ingestPaymentCsvFile reads a real file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "day2-ingest-"));
    try {
      const path = join(dir, "payments.csv");
      writeFileSync(path, "date,revenue_usd,refunds_usd,chargebacks_usd\n2026-09-01,9.99,0,0\n");
      const result = ingestPaymentCsvFile(path);
      expect(result.status).toBe("ingested");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("named platform adapters — fail closed with no real credentials", () => {
  test("ingestFromAdPlatform reports not_configured when the env var is unset", async () => {
    delete process.env.DAY2_META_ADS_ACCESS_TOKEN;
    const result = await ingestFromAdPlatform("meta_ads", { startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(result.status).toBe("not_configured");
    if (result.status !== "not_configured") throw new Error("expected not_configured");
    expect(result.reason).toContain("DAY2_META_ADS_ACCESS_TOKEN");
  });

  test("ingestFromPaymentProvider reports not_configured when the env var is unset", async () => {
    delete process.env.DAY2_STRIPE_SECRET_KEY;
    const result = await ingestFromPaymentProvider("stripe", { startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(result.status).toBe("not_configured");
  });

  test("a present credential reaches the honest not-yet-implemented path, never a fabricated live result", async () => {
    process.env.DAY2_META_ADS_ACCESS_TOKEN = "fake-token-for-test";
    try {
      const result = await ingestFromAdPlatform("meta_ads", { startDate: "2026-09-01", endDate: "2026-09-30" });
      expect(result.status).toBe("parse_failed");
      if (result.status !== "parse_failed") throw new Error("expected parse_failed");
      expect(result.reason).toContain("not implemented");
    } finally {
      delete process.env.DAY2_META_ADS_ACCESS_TOKEN;
    }
  });
});
