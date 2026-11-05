import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AscCredential, PlayCredential } from "../mobile-release/credentials";
import { createAppleReports, downloadsByDay, engagementByDay, isoDay, parseSalesReport, parseTsv, REPORT_DOWNLOADS, REPORT_ENGAGEMENT, REPORT_SESSIONS, sessionsByDay, type AppleReports } from "./apple";
import { fetchStoreNumbers, putSeries, snapshotAdSpend, snapshotField } from "./fetch";
import { bucketName, createPlayReports, decodeReport, parseInstallsCsv, parseVitals, type PlayReports } from "./google";
import type { NumbersStore } from "./store";
import { emptyNumbersDoc, normalizeDoc, trimDoc, type NumbersDoc } from "./types";

/**
 * Numbers' store clients and the store pass, with Apple's and Google's
 * files as fixtures (src/numbers/testdata/) and their APIs mocked. No network.
 */

const data = (f: string) => readFileSync(join(import.meta.dir, "testdata", f));
const text = (f: string) => data(f).toString("utf-8");
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const asc: AscCredential = { issuerId: "69a6de7e-1111-47e3-e053-5b8c7c11a4d1", keyId: "2X9R4HXF34", privateKey: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const play: PlayCredential = { clientEmail: "day2@dotty.iam.gserviceaccount.com", privateKey: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const NOW = new Date("2026-11-03T10:00:00Z");
const APPLE_ID = "6740000001";

type Route = { method?: string; match: RegExp; respond: (url: string, init: RequestInit) => Response | Promise<Response> };
function fakeFetch(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body ?? null, auth: headers.authorization ?? null });
    const r = routes.find((x) => (x.method ?? "GET") === method && x.match.test(url));
    if (!r) return new Response(JSON.stringify({ error: { message: `no route for ${method} ${url}` } }), { status: 599 });
    return r.respond(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

describe("Apple's files", () => {
  test("Sales and Trends: first downloads by product type, this app only, no in-app purchases, refunds count", () => {
    expect(parseSalesReport(text("sales-2026-10-30.tsv"), APPLE_ID)).toEqual({ downloads: 14, redownloads: 4, updates: 40 });
    // Without the app's Apple ID every app on the account counts.
    expect(parseSalesReport(text("sales-2026-10-30.tsv"), null).downloads).toBe(113);
  });

  test("App Store Downloads: first-time downloads and redownloads per day, pre-orders and updates left out", () => {
    expect(downloadsByDay(parseTsv(text("downloads.tsv")), APPLE_ID)).toEqual({ downloads: { "2026-10-29": 11, "2026-10-30": 14 }, redownloads: { "2026-10-29": 1 } });
  });

  test("Discovery and Engagement: impressions (all engagement types) and product page views only", () => {
    expect(engagementByDay(parseTsv(text("engagement.tsv")), APPLE_ID)).toEqual({ impressions: { "2026-10-29": 420 }, pageViews: { "2026-10-29": 75 } });
  });

  test("App Sessions: sessions and devices per day", () => {
    expect(sessionsByDay(parseTsv(text("sessions.tsv")), APPLE_ID)).toEqual({ sessions: { "2026-10-29": 150 }, devices: { "2026-10-29": 50 } });
  });

  test("dates in both of Apple's formats", () => {
    expect(isoDay("10/30/2026")).toBe("2026-10-30");
    expect(isoDay("2026-10-30")).toBe("2026-10-30");
    expect(isoDay("soon")).toBeNull();
  });
});

describe("Google's files", () => {
  test("the installs overview report is UTF-16 and counts installs by users per day", () => {
    const bytes = new Uint8Array(data("installs_de.dotty.app_202610_overview.csv"));
    expect(bytes[0]).toBe(0xff);
    const r = parseInstallsCsv(decodeReport(bytes));
    expect(r).toEqual({ column: "Daily User Installs", byDay: { "2026-10-01": 3, "2026-10-02": 5, "2026-10-03": 5 } });
  });

  test("older files without “Daily User Installs” fall back to install events", () => {
    const r = parseInstallsCsv('Date,Package Name,Install events\n2026-09-01,de.dotty.app,"7"\n');
    expect(r).toEqual({ column: "Install events", byDay: { "2026-09-01": 7 } });
    expect(parseInstallsCsv("Date,Something\n2026-09-01,1").column).toBeNull();
  });

  test("the bucket from what the owner pasted", () => {
    expect(bucketName("gs://pubsite_prod_rev_01234567890987654321/stats/installs")).toBe("pubsite_prod_rev_01234567890987654321");
    expect(bucketName("pubsite_prod_123")).toBe("pubsite_prod_123");
    expect(bucketName("gs://my-bucket")).toBeNull();
  });

  test("vitals rows: rate and users per day", () => {
    const rows = [
      { startTime: { year: 2026, month: 11, day: 1 }, metrics: [{ metric: "crashRate", decimalValue: { value: "0.0123" } }, { metric: "distinctUsers", decimalValue: { value: "812" } }] },
      { startTime: { year: 2026, month: 11, day: 2 }, metrics: [{ metric: "distinctUsers", decimalValue: { value: "5" } }] },
    ];
    expect(parseVitals(rows, "crashRate")).toEqual({ "2026-11-01": { rate: 0.0123, users: 812 } });
  });
});

describe("App Store Connect client", () => {
  test("a day's sales: gzip'd, 1_0 refused → the version Apple names, 404 → no sales", async () => {
    const gz = gzipSync(data("sales-2026-10-30.tsv"));
    const f = fakeFetch([
      { match: /reportDate\]=2026-10-30&filter\[version\]=1_0/, respond: () => json({ errors: [{ detail: "The version parameter you have specified is invalid. The latest version for this report is 1_1." }] }, 400) },
      { match: /reportDate\]=2026-10-30&filter\[version\]=1_1/, respond: () => new Response(gz, { status: 200, headers: { "content-type": "application/a-gzip" } }) },
      { match: /reportDate\]=2026-10-31/, respond: () => json({ errors: [{ detail: "There were no sales for the date specified." }] }, 404) },
      { match: /reportDate\]=2026-11-01/, respond: () => json({ errors: [{ status: "403" }] }, 403) },
    ]);
    const a = createAppleReports(asc, { fetch: f.fetch, now: () => NOW, sleep: noSleep });
    const t = await a.salesDay("85912345", "2026-10-30");
    expect(parseSalesReport(t!, APPLE_ID).downloads).toBe(14);
    expect(await a.salesDay("85912345", "2026-10-31")).toBeNull();
    await expect(a.salesDay("85912345", "2026-11-01")).rejects.toThrow("Sales and Reports, Finance or Admin role");
    expect(f.calls[0]!.url).toContain("filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=85912345");
    expect(f.calls[0]!.auth).toStartWith("Bearer ey");
  });

  test("analytics: asks for an ONGOING request once, then reads instances and their files", async () => {
    const f = fakeFetch([
      { match: /\/v1\/apps\/6740000001\/analyticsReportRequests/, respond: () => json({ data: [] }) },
      { method: "POST", match: /\/v1\/analyticsReportRequests$/, respond: () => json({ data: { type: "analyticsReportRequests", id: "req1" } }, 201) },
      { match: /\/v1\/analyticsReportRequests\/req1\/reports\?filter\[name\]=App%20Store%20Downloads%20Standard/, respond: () => json({ data: [{ type: "analyticsReports", id: "rep-dl", attributes: { name: REPORT_DOWNLOADS, category: "APP_STORE_COMMERCE" } }] }) },
      { match: /\/v1\/analyticsReports\/rep-dl\/instances/, respond: () => json({ data: [{ type: "analyticsReportInstances", id: "in1", attributes: { granularity: "DAILY", processingDate: "2026-10-31" } }] }) },
      { match: /\/v1\/analyticsReportInstances\/in1\/segments/, respond: () => json({ data: [{ type: "analyticsReportSegments", id: "s1", attributes: { url: "https://apple-reports.example/s1.gz", checksum: "x", sizeInBytes: 10 } }] }) },
      { match: /apple-reports\.example\/s1\.gz/, respond: () => new Response(gzipSync(data("downloads.tsv"))) },
    ]);
    const a = createAppleReports(asc, { fetch: f.fetch, now: () => NOW, sleep: noSleep });
    expect(await a.ongoingRequest(APPLE_ID)).toBeNull();
    expect(await a.createOngoingRequest(APPLE_ID)).toBe("req1");
    expect(f.calls[1]!.body).toEqual({ data: { type: "analyticsReportRequests", attributes: { accessType: "ONGOING" }, relationships: { app: { data: { type: "apps", id: APPLE_ID } } } } });
    const rep = await a.report("req1", REPORT_DOWNLOADS);
    expect(rep).toBe("rep-dl");
    expect(await a.instances(rep!)).toEqual([{ id: "in1", processingDate: "2026-10-31" }]);
    const rows = await a.instanceRows("in1");
    expect(downloadsByDay(rows, APPLE_ID).downloads["2026-10-29"]).toBe(11);
    // The signed download link goes without the API token.
    expect(f.calls.at(-1)!.auth).toBeNull();
  });
});

describe("Google Play client", () => {
  const token = { method: "POST", match: /oauth2\.googleapis\.com\/token/, respond: () => json({ access_token: "ya29.test", expires_in: 3600 }) };

  test("installs: the month's overview file from the bucket; 404 = not written yet; 403 = missing permission", async () => {
    const f = fakeFetch([
      token,
      { match: /\/b\/pubsite_prod_rev_1\/o\/stats%2Finstalls%2Finstalls_de\.dotty\.app_202610_overview\.csv\?alt=media/, respond: () => new Response(data("installs_de.dotty.app_202610_overview.csv")) },
      { match: /installs_de\.dotty\.app_202611_overview\.csv/, respond: () => json({ error: { message: "No such object" } }, 404) },
      { match: /\/b\/pubsite_prod_rev_2\/o\?prefix=/, respond: () => json({ error: { message: "forbidden" } }, 403) },
      { match: /\/b\/pubsite_prod_rev_1\/o\?prefix=stats%2Finstalls%2Finstalls_de\.dotty\.app_/, respond: () => json({ items: [{ name: "stats/installs/installs_de.dotty.app_202610_overview.csv" }] }) },
    ]);
    const p = createPlayReports(play, { fetch: f.fetch, now: () => NOW });
    const t = await p.installsMonth("pubsite_prod_rev_1", "de.dotty.app", "202610");
    expect(parseInstallsCsv(t!).byDay["2026-10-02"]).toBe(5);
    expect(await p.installsMonth("pubsite_prod_rev_1", "de.dotty.app", "202611")).toBeNull();
    expect(await p.installReports("pubsite_prod_rev_1", "de.dotty.app")).toHaveLength(1);
    await expect(p.installReports("pubsite_prod_rev_2", "de.dotty.app")).rejects.toMatchObject({ status: 403 });
    const tokenCall = f.calls.find((c) => c.url.includes("oauth2"))!;
    expect(String(tokenCall.body)).toContain("grant_type=urn");
  });

  test("vitals: asks how fresh the data is, then queries daily rates in Los Angeles time", async () => {
    const f = fakeFetch([
      token,
      { match: /crashRateMetricSet$/, respond: () => json({ name: "apps/de.dotty.app/crashRateMetricSet", freshnessInfo: { freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 11, day: 2, timeZone: { id: "America/Los_Angeles" } } }] } }) },
      { method: "POST", match: /crashRateMetricSet:query$/, respond: () => json({ rows: [{ aggregationPeriod: "DAILY", startTime: { year: 2026, month: 11, day: 1 }, metrics: [{ metric: "crashRate", decimalValue: { value: "0.004" } }, { metric: "distinctUsers", decimalValue: { value: "300" } }] }] }) },
    ]);
    const p = createPlayReports(play, { fetch: f.fetch, now: () => NOW });
    expect(await p.vitals("de.dotty.app", "crashRate", 30)).toEqual({ "2026-11-01": { rate: 0.004, users: 300 } });
    const q = f.calls.find((c) => c.url.endsWith(":query"))!;
    expect(q.url).toBe("https://playdeveloperreporting.googleapis.com/v1beta1/apps/de.dotty.app/crashRateMetricSet:query");
    expect(q.body).toMatchObject({ timelineSpec: { aggregationPeriod: "DAILY", startTime: { year: 2026, month: 10, day: 3, timeZone: { id: "America/Los_Angeles" } }, endTime: { year: 2026, month: 11, day: 2 } }, metrics: ["crashRate", "distinctUsers"] });
  });
});

// ---------------------------------------------------------------------------
// The store pass
// ---------------------------------------------------------------------------

function memoryStore(start: NumbersDoc = emptyNumbersDoc()): NumbersStore & { doc: () => NumbersDoc } {
  let doc = start;
  return {
    doc: () => doc,
    async load() {
      return normalizeDoc(JSON.parse(JSON.stringify(doc)));
    },
    async update(_id, fn) {
      const r = await fn(normalizeDoc(JSON.parse(JSON.stringify(doc))));
      doc = r.doc;
      return r.result;
    },
  };
}

function fakeApple(o: { sales?: (day: string) => string | null; requestFails?: number; instances?: Record<string, Array<{ id: string; processingDate: string; rows: Array<Record<string, string>> }>> } = {}): AppleReports & { salesCalls: string[] } {
  const salesCalls: string[] = [];
  return {
    salesCalls,
    findAppId: async () => APPLE_ID,
    salesDay: async (_v: string, day: string) => {
      salesCalls.push(day);
      return o.sales ? o.sales(day) : null;
    },
    ongoingRequest: async () => null,
    createOngoingRequest: async () => {
      if (o.requestFails) {
        const { AppleReportError, appleReason } = await import("./apple");
        throw new AppleReportError(appleReason(o.requestFails, "", "request"), o.requestFails);
      }
      return "req1";
    },
    report: async (_r: string, name: string) => (o.instances?.[name] ? `rep:${name}` : null),
    instances: async (rep: string) => (o.instances?.[rep.slice(4)] ?? []).map(({ id, processingDate }) => ({ id, processingDate })),
    instanceRows: async (id: string) => Object.values(o.instances ?? {}).flat().find((i) => i.id === id)!.rows,
  } as unknown as AppleReports & { salesCalls: string[] };
}

describe("the store pass", () => {
  test("backfills daily sales once, keeps 404s of the last days open, and records zero for older days without sales", async () => {
    const store = memoryStore({ ...emptyNumbersDoc(), settings: { appleVendorNumber: "85912345", playBucket: null } });
    const apple = fakeApple({ sales: (day) => (day === "2026-10-30" ? text("sales-2026-10-30.tsv") : null) });
    const r = await fetchStoreNumbers("a1", { store, apple, play: null, ids: { bundleId: "de.dotty.app", packageName: null, appStoreId: null }, now: NOW });
    const s = store.doc().series["ios.salesUnits"]!;
    expect(s["2026-10-30"]).toEqual({ v: 14 });
    expect(s["2026-10-20"]).toEqual({ v: 0 });
    expect(s["2026-11-02"]).toBeUndefined(); // may not be published yet
    expect(apple.salesCalls).toHaveLength(180);
    expect(store.doc().apple).toMatchObject({ appId: APPLE_ID, analyticsRequestId: "req1", sales: { ok: true } });
    // Apple hasn't made the first analytics reports yet.
    expect(store.doc().apple.analytics.error).toContain("1–2 days");
    expect(r.notes.join(" ")).toContain("1–2 days");

    // The next pass only asks for what's missing.
    const again = fakeApple({ sales: () => null });
    await fetchStoreNumbers("a1", { store, apple: again, play: null, ids: { bundleId: "de.dotty.app", packageName: null, appStoreId: null }, now: NOW });
    expect(again.salesCalls).toEqual(["2026-11-02", "2026-11-01"]);
  });

  test("analytics instances: a newer processing date overwrites a day, an older one doesn't", async () => {
    const rows = (n: string) => [{ Date: "2026-10-29", "App Apple Identifier": APPLE_ID, "Download Type": "First-time Download", Counts: n }];
    const store = memoryStore();
    const apple = fakeApple({
      instances: {
        [REPORT_DOWNLOADS]: [
          { id: "i2", processingDate: "2026-10-31", rows: rows("12") },
          { id: "i1", processingDate: "2026-10-30", rows: rows("9") },
        ],
        [REPORT_ENGAGEMENT]: [{ id: "e1", processingDate: "2026-10-31", rows: parseTsv(text("engagement.tsv")) }],
        [REPORT_SESSIONS]: [{ id: "s1", processingDate: "2026-10-31", rows: parseTsv(text("sessions.tsv")) }],
      },
    });
    await fetchStoreNumbers("a1", { store, apple, play: null, ids: { bundleId: "de.dotty.app", packageName: null, appStoreId: APPLE_ID }, now: NOW });
    const d = store.doc();
    expect(d.series["ios.downloads"]!["2026-10-29"]).toEqual({ v: 12, p: "2026-10-31" });
    expect(d.series["ios.pageViews"]!["2026-10-29"]!.v).toBe(75);
    expect(d.series["ios.sessions"]!["2026-10-29"]!.v).toBe(150);
    expect(d.apple.analytics).toMatchObject({ ok: true, error: null });
    expect(d.apple.seenInstances.sort()).toEqual(["e1", "i1", "i2", "s1"]);
    expect(putSeries(d, "ios.downloads", { "2026-10-29": 1 }, "2026-10-29").series["ios.downloads"]!["2026-10-29"]!.v).toBe(12);
  });

  test("a key without the Admin role can't start App Analytics: said in plain words", async () => {
    const store = memoryStore();
    await fetchStoreNumbers("a1", { store, apple: fakeApple({ requestFails: 403 }), play: null, ids: { bundleId: "de.dotty.app", packageName: null, appStoreId: APPLE_ID }, now: NOW });
    expect(store.doc().apple.analytics).toMatchObject({ ok: false, error: expect.stringContaining("Admin role") });
  });

  test("Google Play: installs per month (older months read once), vitals, permission errors", async () => {
    const store = memoryStore({ ...emptyNumbersDoc(), settings: { appleVendorNumber: null, playBucket: "pubsite_prod_rev_1" } });
    const months: string[] = [];
    const playOk = {
      installReports: async () => [],
      installsMonth: async (_b: string, _p: string, m: string) => {
        months.push(m);
        return m === "202610" || m === "202608" ? decodeReport(new Uint8Array(data("installs_de.dotty.app_202610_overview.csv"))) : null;
      },
      vitals: async (_p: string, metric: string) => (metric === "crashRate" ? { "2026-11-01": { rate: 0.004, users: 300 } } : { "2026-11-01": { rate: 0.001, users: 300 } }),
    } as unknown as PlayReports;
    await fetchStoreNumbers("a1", { store, apple: null, play: playOk, ids: { bundleId: null, packageName: "de.dotty.app", appStoreId: null }, now: NOW });
    const d = store.doc();
    expect(d.series["android.installs"]!["2026-10-02"]).toEqual({ v: 5 });
    expect(d.series["android.anrRate"]!["2026-11-01"]!.v).toBe(0.001);
    expect(d.google.installs.ok).toBe(true);
    expect(months).toEqual(["202611", "202610", "202609", "202608", "202607", "202606", "202605"]);
    months.length = 0;
    await fetchStoreNumbers("a1", { store, apple: null, play: playOk, ids: { bundleId: null, packageName: "de.dotty.app", appStoreId: null }, now: NOW });
    // The current and last month again; 202608 was read already, the empty months are asked again.
    expect(months).toEqual(["202611", "202610", "202609", "202607", "202606", "202605"]);

    const { GoogleError } = await import("../money/google-play");
    const denied = { ...playOk, installsMonth: async () => Promise.reject(new GoogleError("403 forbidden", 403)), vitals: async () => Promise.reject(new GoogleError("403 denied", 403)) } as unknown as PlayReports;
    await fetchStoreNumbers("a1", { store, apple: null, play: denied, ids: { bundleId: null, packageName: "de.dotty.app", appStoreId: null }, now: NOW });
    expect(store.doc().google.installs.error).toContain("View app information and download bulk reports");
    expect(store.doc().google.vitals.error).toContain("Developer Reporting API");
    // What was read before stays.
    expect(store.doc().series["android.installs"]!["2026-10-02"]).toEqual({ v: 5 });
  });

  test("snapshots: ad spend per campaign per day, launches and crashes per finished day; old days trimmed", () => {
    let d = snapshotAdSpend(emptyNumbersDoc(), [{ betId: "B-1", platform: "meta", spendUsd: 12.345 }], NOW);
    expect(d.adSpend["2026-11-03"]).toEqual({ "B-1:meta": 12.35 });
    d = snapshotField(d, { "2026-11-02": { launches: 40, crashed: 1 }, "2026-11-03": { launches: 5, crashed: 0 } }, NOW);
    expect(Object.keys(d.field)).toEqual(["2026-11-02"]);
    d = { ...d, field: { ...d.field, "2024-01-01": { launches: 1, crashed: 0 } } };
    expect(Object.keys(trimDoc(d, NOW).field)).toEqual(["2026-11-02"]);
  });
});
