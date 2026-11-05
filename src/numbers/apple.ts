import { gunzipSync } from "node:zlib";
import { ascJwt } from "../mobile-release/app-store";
import type { AscCredential } from "../mobile-release/credentials";

/**
 * App Store Connect reports for Numbers, read with the owner's API key
 * (the one stored for releases):
 *
 *  - Sales and Trends: GET /v1/salesReports (SALES / SUMMARY / DAILY,
 *    version 1_0), a gzip'd tab-separated file per day. Needs the vendor
 *    number (Payments and Financial Reports) and a key with the Sales and
 *    Reports, Finance or Admin role. A day without sales answers 404.
 *  - Analytics Reports: an ONGOING analyticsReportRequest for the app
 *    (creating it needs the Admin role), then reports → instances (DAILY)
 *    → segments → gzip'd tab-separated files. The first data comes 1–2 days
 *    after the request; a newer instance overwrites older ones for the same
 *    date (Apple: "Use the latest instance").
 *
 * Everything that reads a file is a pure function below, tested with
 * fixtures (src/numbers/testdata/).
 */

const BASE = "https://api.appstoreconnect.apple.com";

/** Product type identifiers that are first downloads of an app (Apple's "Product Type Identifiers" reference). */
export const DOWNLOAD_TYPES = new Set(["1", "1-B", "1E", "1EP", "1EU", "1F", "1T", "F1", "F1-B"]);
export const REDOWNLOAD_TYPES = new Set(["3", "3F"]);
export const UPDATE_TYPES = new Set(["7", "7F", "7T", "F7"]);

export const REPORT_DOWNLOADS = "App Store Downloads Standard";
export const REPORT_ENGAGEMENT = "App Store Discovery and Engagement Standard";
export const REPORT_SESSIONS = "App Sessions Standard";

export class AppleReportError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Pure. A plain-language reason for an App Store Connect error. */
export function appleReason(status: number | undefined, body: string, what: string): string {
  if (status === 401) return "App Store Connect didn't accept the API key — connect it again on Releases.";
  if (status === 403)
    return what === "request"
      ? "The App Store Connect key can't start App Analytics reports: that needs a key with the Admin role (Users and Access → Integrations)."
      : "The App Store Connect key can't read reports: it needs the Sales and Reports, Finance or Admin role (Users and Access → Integrations).";
  if (status === 429) return "App Store Connect asked day2 to slow down — it tries again on the next pass.";
  let detail = body.slice(0, 200);
  try {
    const j = JSON.parse(body) as { errors?: Array<{ detail?: string; title?: string }> };
    detail = j.errors?.map((e) => e.detail ?? e.title).filter(Boolean).join("; ") || detail;
  } catch {
    /* not JSON */
  }
  return `App Store Connect couldn't give the ${what} (${status ?? "network"}${detail ? `: ${detail}` : ""}).`;
}

/** Pure. Unzips if the bytes are gzip, else reads them as text. */
export function readMaybeGzip(bytes: Uint8Array): string {
  const b = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes);
  return b.toString("utf-8");
}

/** Pure. A tab-separated file with a header row → rows keyed by column name. */
export function parseTsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0]!.split("\t").map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split("\t");
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

/** Pure. "11/01/2026" or "2026-11-01" → "2026-11-01"; null otherwise. */
export function isoDay(s: string | undefined): string | null {
  if (!s) return null;
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1]! : null;
}

const num = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export type SalesDay = { downloads: number; redownloads: number; updates: number };

/**
 * Pure. One day's Sales and Trends summary → this app's units: first
 * downloads, redownloads and updates (by product type identifier). Rows of
 * other apps on the account (another Apple Identifier) and in-app purchases
 * are left out. Refunds are negative units and count as such.
 */
export function parseSalesReport(text: string, appleId: string | null): SalesDay {
  const out: SalesDay = { downloads: 0, redownloads: 0, updates: 0 };
  for (const r of parseTsv(text)) {
    if (appleId && r["Apple Identifier"] && r["Apple Identifier"] !== appleId) continue;
    const t = r["Product Type Identifier"] ?? "";
    const units = num(r["Units"]);
    if (DOWNLOAD_TYPES.has(t)) out.downloads += units;
    else if (REDOWNLOAD_TYPES.has(t)) out.redownloads += units;
    else if (UPDATE_TYPES.has(t)) out.updates += units;
  }
  return out;
}

type PerDay = Record<string, number>;
const add = (m: PerDay, day: string | null, n: number) => {
  if (day) m[day] = (m[day] ?? 0) + n;
};
const mine = (r: Record<string, string>, appleId: string | null) => !appleId || !r["App Apple Identifier"] || r["App Apple Identifier"] === appleId;

/** Pure. App Store Downloads rows → first-time downloads and redownloads per day (updates and restores left out). */
export function downloadsByDay(rows: Array<Record<string, string>>, appleId: string | null): { downloads: PerDay; redownloads: PerDay } {
  const downloads: PerDay = {};
  const redownloads: PerDay = {};
  for (const r of rows) {
    if (!mine(r, appleId) || r["Pre-Order"]?.toLowerCase() === "yes") continue;
    const t = (r["Download Type"] ?? "").toLowerCase();
    const day = isoDay(r["Date"]);
    if (t === "first-time download") add(downloads, day, num(r["Counts"]));
    else if (t === "redownload") add(redownloads, day, num(r["Counts"]));
  }
  return { downloads, redownloads };
}

/** Pure. Discovery and Engagement rows → impressions and product page views per day (every engagement type summed). */
export function engagementByDay(rows: Array<Record<string, string>>, appleId: string | null): { impressions: PerDay; pageViews: PerDay } {
  const impressions: PerDay = {};
  const pageViews: PerDay = {};
  for (const r of rows) {
    if (!mine(r, appleId)) continue;
    const ev = (r["Event"] ?? "").toLowerCase();
    const day = isoDay(r["Date"]);
    if (ev === "impression") add(impressions, day, num(r["Counts"]));
    else if (ev === "page view" && (r["Page Type"] ?? "").toLowerCase() === "product page") add(pageViews, day, num(r["Counts"]));
  }
  return { impressions, pageViews };
}

/** Pure. App Sessions rows → sessions and (summed over rows, so approximate) devices per day. */
export function sessionsByDay(rows: Array<Record<string, string>>, appleId: string | null): { sessions: PerDay; devices: PerDay } {
  const sessions: PerDay = {};
  const devices: PerDay = {};
  for (const r of rows) {
    if (!mine(r, appleId)) continue;
    const day = isoDay(r["Date"]);
    add(sessions, day, num(r["Sessions"]));
    add(devices, day, num(r["Unique Devices"]));
  }
  return { sessions, devices };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Deps = { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void> };
type Res<A = Record<string, unknown>> = { id: string; type: string; attributes?: A };
type ListDoc<A> = { data: Array<Res<A>>; links?: { next?: string } };

export type AppleReports = ReturnType<typeof createAppleReports>;

export function createAppleReports(cred: AscCredential, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let token: { value: string; until: number } | null = null;
  const bearer = () => {
    const t = now().getTime();
    if (!token || token.until - 60_000 < t) token = { value: ascJwt(cred, now()), until: t + 1140_000 };
    return token.value;
  };

  /** Raw response; retries 429/5xx twice. Absolute URLs are used as they are (pagination, download links). */
  async function raw(pathOrUrl: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`;
    let last: Response | null = null;
    for (let i = 0; i < 3; i++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: init.method ?? (init.body ? "POST" : "GET"),
          headers: { ...(init.auth === false ? {} : { authorization: `Bearer ${bearer()}` }), ...(init.body ? { "content-type": "application/json" } : {}) },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (err) {
        if (i === 2) throw new AppleReportError(`couldn't reach App Store Connect (${(err as Error).message.slice(0, 120)})`);
        await sleep(500 * 2 ** i);
        continue;
      }
      if (res.status !== 429 && res.status < 500) return res;
      last = res;
      await sleep(1000 * 2 ** i);
    }
    return last!;
  }

  async function json<T>(path: string, what: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await raw(path, init);
    const text = await res.text();
    if (!res.ok) throw new AppleReportError(appleReason(res.status, text, what), res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function all<A>(path: string, what: string, max = 10): Promise<Array<Res<A>>> {
    const out: Array<Res<A>> = [];
    let next: string | undefined = path;
    for (let i = 0; next && i < max; i++) {
      const page: ListDoc<A> = await json<ListDoc<A>>(next, what);
      out.push(...(page.data ?? []));
      next = page.links?.next;
    }
    return out;
  }

  return {
    /** The app's Apple ID, by bundle id (null when the key's team has no such app). */
    async findAppId(bundleId: string): Promise<string | null> {
      const d = await json<ListDoc<{ bundleId?: string }>>(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=5`, "app");
      return d.data.find((a) => a.attributes?.bundleId === bundleId)?.id ?? null;
    },

    /** One day's Sales and Trends summary for the vendor; null when Apple reports no sales that day. */
    async salesDay(vendorNumber: string, day: string): Promise<string | null> {
      const q = (version: string | null) =>
        `/v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[vendorNumber]=${encodeURIComponent(vendorNumber)}&filter[reportDate]=${day}${version ? `&filter[version]=${version}` : ""}`;
      let res = await raw(q("1_0"));
      if (res.status === 400) {
        // Apple names the version it wants when 1_0 is refused ("The latest version for this report is 1_1").
        const text = await res.text();
        const v = /version for this report is (\d_\d)/i.exec(text)?.[1];
        if (!v) throw new AppleReportError(appleReason(400, text, "sales report"), 400);
        res = await raw(q(v));
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) throw new AppleReportError(appleReason(res.status, await res.text(), "sales report"), res.status);
      return readMaybeGzip(new Uint8Array(await res.arrayBuffer()));
    },

    /** The app's ONGOING analytics report request, or null (stopped ones don't count). */
    async ongoingRequest(appId: string): Promise<string | null> {
      const list = await all<{ accessType?: string; stoppedDueToInactivity?: boolean }>(`/v1/apps/${appId}/analyticsReportRequests?filter[accessType]=ONGOING&limit=50`, "analytics report requests", 2);
      return list.find((r) => r.attributes?.accessType === "ONGOING" && !r.attributes?.stoppedDueToInactivity)?.id ?? null;
    },

    async createOngoingRequest(appId: string): Promise<string> {
      const d = await json<{ data: Res }>("/v1/analyticsReportRequests", "request", {
        method: "POST",
        body: { data: { type: "analyticsReportRequests", attributes: { accessType: "ONGOING" }, relationships: { app: { data: { type: "apps", id: appId } } } } },
      });
      return d.data.id;
    },

    /** The report of that name in the request (null until Apple made it). */
    async report(requestId: string, name: string): Promise<string | null> {
      const list = await all<{ name?: string }>(`/v1/analyticsReportRequests/${requestId}/reports?filter[name]=${encodeURIComponent(name)}&limit=50`, "analytics reports", 2);
      return list.find((r) => r.attributes?.name === name)?.id ?? null;
    },

    /** The report's daily instances, with their processing dates. */
    async instances(reportId: string): Promise<Array<{ id: string; processingDate: string }>> {
      const list = await all<{ granularity?: string; processingDate?: string }>(`/v1/analyticsReports/${reportId}/instances?filter[granularity]=DAILY&limit=200`, "analytics report instances", 5);
      return list.filter((r) => r.attributes?.processingDate).map((r) => ({ id: r.id, processingDate: r.attributes!.processingDate! }));
    },

    /** The instance's files, read and joined (header rows kept per file). */
    async instanceRows(instanceId: string): Promise<Array<Record<string, string>>> {
      const segs = await all<{ url?: string }>(`/v1/analyticsReportInstances/${instanceId}/segments?limit=50`, "analytics report segments", 3);
      const rows: Array<Record<string, string>> = [];
      for (const s of segs) {
        if (!s.attributes?.url) continue;
        const res = await raw(s.attributes.url, { auth: false });
        if (!res.ok) throw new AppleReportError(appleReason(res.status, await res.text(), "analytics report file"), res.status);
        rows.push(...parseTsv(readMaybeGzip(new Uint8Array(await res.arrayBuffer()))));
      }
      return rows;
    },
  };
}
