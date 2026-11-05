import { googleClient, GoogleError, scopedJwt } from "../money/google-play";
import type { PlayCredential } from "../mobile-release/credentials";

/**
 * Google Play reports for Numbers, read with the owner's service account
 * (the one stored for releases):
 *
 *  - Installs: the monthly installs overview report Google writes to the
 *    developer's Cloud Storage bucket,
 *    gs://pubsite_prod_…/stats/installs/installs_<package>_<yyyymm>_overview.csv
 *    (UTF-16, one row per day). The service account needs "View app
 *    information and download bulk reports" in Play Console (Users and
 *    permissions) — an owner step, checked by the connection test.
 *  - Vitals: crash rate and ANR rate per day from the Play Developer
 *    Reporting API (crashRateMetricSet / anrRateMetricSet), days in
 *    America/Los_Angeles as the API requires.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STORAGE = "https://storage.googleapis.com/storage/v1";
const REPORTING = "https://playdeveloperreporting.googleapis.com/v1beta1";
export const SCOPE_STORAGE = "https://www.googleapis.com/auth/devstorage.read_only";
export const SCOPE_REPORTING = "https://www.googleapis.com/auth/playdeveloperreporting";

/** Pure. What the owner pasted ("gs://pubsite_prod_rev_0123/…", the bare name) → the bucket name, or null. */
export function bucketName(input: string): string | null {
  const m = /^(?:gs:\/\/)?(pubsite_prod_[A-Za-z0-9_-]+)(?:\/.*)?$/.exec(input.trim());
  return m ? m[1]! : null;
}

/** Pure. UTF-16 (with its byte order mark, as Google writes these files) or UTF-8 → text. */
export function decodeReport(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // No mark: UTF-16LE still shows as every other byte being 0 for plain text.
  if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder("utf-16le").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** Pure. One CSV line (quoted cells allowed). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Columns that count new installs by people, best first (Google renamed them over the years). */
export const INSTALL_COLUMNS = ["Daily User Installs", "Install events", "Daily Device Installs"];

/**
 * Pure. The installs overview report → installs per day, from the first of
 * INSTALL_COLUMNS the file has; `column` says which one (null: none found).
 */
export function parseInstallsCsv(text: string): { byDay: Record<string, number>; column: string | null } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { byDay: {}, column: null };
  const head = csvCells(lines[0]!);
  const column = INSTALL_COLUMNS.find((c) => head.includes(c)) ?? null;
  const di = head.indexOf("Date");
  if (!column || di < 0) return { byDay: {}, column };
  const ci = head.indexOf(column);
  const byDay: Record<string, number> = {};
  for (const l of lines.slice(1)) {
    const cells = csvCells(l);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(cells[di] ?? "") ? cells[di]! : null;
    const n = Number(cells[ci]);
    if (day && Number.isFinite(n)) byDay[day] = (byDay[day] ?? 0) + n;
  }
  return { byDay, column };
}

type GDate = { year: number; month: number; day: number };
type MetricsRow = { startTime?: GDate; metrics?: Array<{ metric?: string; decimalValue?: { value?: string } }> };

const pad = (n: number) => String(n).padStart(2, "0");
const dayOfG = (d: GDate) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;
const gDate = (day: string): GDate => {
  const [y, m, d] = day.split("-").map(Number);
  return { year: y!, month: m!, day: d! };
};

/** Pure. A metric set query's rows → per day: the rate (0.012 = 1.2%) and the users behind it. */
export function parseVitals(rows: MetricsRow[], metric: "crashRate" | "anrRate"): Record<string, { rate: number; users: number | null }> {
  const out: Record<string, { rate: number; users: number | null }> = {};
  for (const r of rows) {
    if (!r.startTime) continue;
    const get = (m: string) => {
      const v = r.metrics?.find((x) => x.metric === m)?.decimalValue?.value;
      const n = v === undefined ? NaN : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const rate = get(metric);
    if (rate === null) continue;
    out[dayOfG(r.startTime)] = { rate, users: get("distinctUsers") };
  }
  return out;
}

/** Pure. A plain-language reason for a Google error, by what was being read. */
export function googleReason(err: unknown, what: "installs" | "vitals"): string {
  const status = err instanceof GoogleError ? err.status : undefined;
  if (status === 401 || /didn't accept the service account key/.test((err as Error).message)) return "Google didn't accept the service account key — connect it again on Releases.";
  if (status === 403)
    return what === "installs"
      ? 'The service account can\'t read the reports bucket: in Play Console → Users and permissions, give it "View app information and download bulk reports".'
      : 'The service account can\'t read Android vitals: enable the "Google Play Developer Reporting API" in its Google Cloud project and give it "View app information" in Play Console.';
  if (status === 404) return what === "installs" ? "That reports bucket or report isn't there — copy the Cloud Storage URI again from Play Console → Download reports." : "Google Play has no vitals for this app yet.";
  return `Google Play couldn't give the ${what === "installs" ? "installs report" : "vitals"} (${(err as Error).message.slice(0, 160)}).`;
}

type Deps = { fetch?: typeof fetch; now?: () => Date };
export type PlayReports = ReturnType<typeof createPlayReports>;

export function createPlayReports(cred: PlayCredential, deps: Deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const reporting = googleClient(cred, SCOPE_REPORTING, deps);
  let token: { value: string; until: number } | null = null;
  const storageToken = async () => {
    if (token && token.until - 60_000 > now().getTime()) return token.value;
    const r = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: scopedJwt(cred, SCOPE_STORAGE, now()) }).toString(),
    });
    if (!r.ok) throw new GoogleError("didn't accept the service account key", r.status, r.status >= 500);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, until: now().getTime() + j.expires_in * 1000 };
    return token.value;
  };
  const storage = async (url: string): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(url, { headers: { authorization: `Bearer ${await storageToken()}` } });
    } catch (err) {
      throw new GoogleError(`couldn't reach Google (${(err as Error).message.slice(0, 120)})`, undefined, true);
    }
    return res;
  };
  const object = (bucket: string, name: string) => `${STORAGE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;

  return {
    /** The installs report files there are for the package (to test the connection). */
    async installReports(bucket: string, pkg: string): Promise<string[]> {
      const res = await storage(`${STORAGE}/b/${encodeURIComponent(bucket)}/o?prefix=${encodeURIComponent(`stats/installs/installs_${pkg}_`)}&fields=items(name)`);
      const text = await res.text();
      if (!res.ok) throw new GoogleError(`${res.status} ${text.slice(0, 200)}`, res.status, res.status >= 500);
      return ((JSON.parse(text || "{}") as { items?: Array<{ name: string }> }).items ?? []).map((i) => i.name);
    },

    /** One month's installs overview ("202611"); null when Google hasn't written it. */
    async installsMonth(bucket: string, pkg: string, month: string): Promise<string | null> {
      const res = await storage(`${object(bucket, `stats/installs/installs_${pkg}_${month}_overview.csv`)}?alt=media`);
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) throw new GoogleError(`${res.status} ${(await res.text()).slice(0, 200)}`, res.status, res.status >= 500);
      return decodeReport(new Uint8Array(await res.arrayBuffer()));
    },

    /** Daily crash or ANR rate for the last `days` days the API has (it says how fresh its data is). */
    async vitals(pkg: string, metric: "crashRate" | "anrRate", days: number): Promise<Record<string, { rate: number; users: number | null }>> {
      const set = metric === "crashRate" ? "crashRateMetricSet" : "anrRateMetricSet";
      const name = `${REPORTING}/apps/${encodeURIComponent(pkg)}/${set}`;
      const meta = await reporting.call<{ freshnessInfo?: { freshnesses?: Array<{ aggregationPeriod?: string; latestEndTime?: GDate }> } }>(name);
      const latest = meta.freshnessInfo?.freshnesses?.find((f) => f.aggregationPeriod === "DAILY")?.latestEndTime;
      if (!latest) return {};
      const end = dayOfG(latest);
      const start = new Date(Date.parse(`${end}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
      const tz = { id: "America/Los_Angeles" };
      const rows: MetricsRow[] = [];
      let pageToken: string | undefined;
      for (let i = 0; i < 5; i++) {
        const r = await reporting.call<{ rows?: MetricsRow[]; nextPageToken?: string }>(`${name}:query`, {
          method: "POST",
          body: { timelineSpec: { aggregationPeriod: "DAILY", startTime: { ...gDate(start), timeZone: tz }, endTime: { ...gDate(end), timeZone: tz } }, metrics: [metric, "distinctUsers"], pageSize: 1000, ...(pageToken ? { pageToken } : {}) },
        });
        rows.push(...(r.rows ?? []));
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
      return parseVitals(rows, metric);
    },
  };
}
