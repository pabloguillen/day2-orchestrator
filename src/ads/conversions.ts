import type { SQL } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventLike } from "../metrics/types";
import { parseTag } from "./results";
import type { Conversion, PlatformId } from "./types";

/**
 * Telling the ad platforms who signed up, so their algorithms find more
 * people like them instead of more clickers.
 *
 * When someone clicks an ad, the platform adds its click id to the link
 * (fbclid, ttclid, gclid, …); day2's field library keeps it with the visit.
 * When that person later signs up or reaches first value, day2 sends the
 * conversion to the platform that brought them, server to server, with the
 * click id — once (deduplicated by day2 and, where supported, by the
 * platform via the event id). No names, emails or raw ids: at most the
 * app's hashed user id.
 */

export interface SentConversions {
  /** Event ids already sent for an app and platform. */
  sent(appId: string, platform: PlatformId): Promise<Set<string>>;
  markSent(appId: string, platform: PlatformId, eventIds: string[], at: Date): Promise<void>;
  /** How many were sent in the window (for "enough data to optimise for sign-ups"). */
  countSince(appId: string, platform: PlatformId, since: Date): Promise<number>;
}

export function fileSentConversions(path: string): SentConversions {
  type Shape = Record<string, Record<string, string>>; // "app|platform" → eventId → at
  const load = (): Shape => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Shape) : {});
  const save = (s: Shape) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, path);
  };
  const k = (a: string, p: PlatformId) => `${a}|${p}`;
  return {
    async sent(appId, platform) {
      return new Set(Object.keys(load()[k(appId, platform)] ?? {}));
    },
    async markSent(appId, platform, ids, at) {
      const s = load();
      const m = (s[k(appId, platform)] ??= {});
      for (const id of ids) m[id] = at.toISOString();
      save(s);
    },
    async countSince(appId, platform, since) {
      return Object.values(load()[k(appId, platform)] ?? {}).filter((t) => t >= since.toISOString()).length;
    },
  };
}

export function dbSentConversions(sql: SQL): SentConversions {
  return {
    async sent(appId, platform) {
      const rows = (await sql`SELECT event_id FROM ad_conversions_sent WHERE app_id = ${appId} AND platform = ${platform}`) as Array<{ event_id: string }>;
      return new Set(rows.map((r) => r.event_id));
    },
    async markSent(appId, platform, ids, at) {
      for (const id of ids) await sql`INSERT INTO ad_conversions_sent (app_id, platform, event_id, sent_at) VALUES (${appId}, ${platform}, ${id}, ${at.toISOString()}) ON CONFLICT DO NOTHING`;
    },
    async countSince(appId, platform, since) {
      const rows = (await sql`SELECT COUNT(*)::int AS n FROM ad_conversions_sent WHERE app_id = ${appId} AND platform = ${platform} AND sent_at >= ${since.toISOString()}`) as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    },
  };
}

/**
 * Pure. The conversions to send to one platform: people who first arrived
 * through one of its ads with its click id, then signed up / reached first
 * value — minus what was already sent.
 */
export function collectConversions(o: { platform: PlatformId; clickParam: string; events: EventLike[]; sent: Set<string>; pageUrl: (betId: string) => string | null }): Conversion[] {
  const byDevice = new Map<string, EventLike[]>();
  for (const e of o.events) {
    const l = byDevice.get(e.deviceId);
    if (l) l.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const out: Conversion[] = [];
  for (const [device, list] of byDevice) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const first = list[0]!;
    // Web: the click id comes with the first visit. Mobile apps: in a later "ad_click"
    // event, sent only after the user agreed (App Tracking Transparency on iOS).
    const campaignId = first.acquisition?.campaignId;
    const consented = list.find((e) => e.type === "ad_click" && e.acquisition?.click && e.acquisition.campaignId === campaignId)?.acquisition;
    const acq = first.acquisition?.click ? first.acquisition : consented;
    const tag = parseTag(campaignId);
    if (!tag?.platform || tag.platform !== o.platform || !acq?.click || acq.click.param.toLowerCase() !== o.clickParam.toLowerCase()) continue;
    const page = o.pageUrl(tag.bet);
    if (!page) continue;
    const user = list.find((e) => e.userId)?.userId;
    for (const name of ["signup", "activated"] as const) {
      const e = list.find((x) => x.type === name);
      if (!e) continue;
      const eventId = `${device}:${name}`;
      if (o.sent.has(eventId)) continue;
      out.push({ eventId, name, at: e.at, click: { param: acq.click.param, value: acq.click.value }, pageUrl: page, ...(user ? { externalId: user } : {}), ...(acq.click.ip ? { clientIp: acq.click.ip } : {}), ...(acq.click.ua ? { userAgent: acq.click.ua } : {}) });
    }
  }
  return out;
}

/** Enough conversions in the last week for a platform to optimise for sign-ups (below this, it optimises for clicks). */
export const OPTIMIZE_FOR_SIGNUPS_AFTER = 15;
