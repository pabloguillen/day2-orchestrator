import type { GrowthEvent } from "./types";

const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|ecosia\.org|baidu\.com|yandex\.[a-z.]+|startpage\.com|qwant\.com)$/;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com)$/;

/** The click ids ad platforms add to ad links (kept so day2 can tell the platform who signed up). */
export const CLICK_PARAMS = ["fbclid", "ttclid", "gclid", "gbraid", "wbraid", "li_fat_id", "ScCid", "epik", "rdt_cid", "twclid"];

/** Where a visitor came from, from the URL that opened the app and the referrer. */
export function acquisitionFrom(url: string, referrer: string, ownHost: string): GrowthEvent["acquisition"] {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const d2 = params.get("d2");
  if (d2) {
    const param = CLICK_PARAMS.find((p) => params.get(p));
    const value = param ? params.get(param)!.slice(0, 500) : null;
    return { campaignId: d2.slice(0, 40), channel: "paid", ...(param && value ? { click: { param, value } } : {}) };
  }
  if (params.get("ref") === "share") return { channel: "shared_link" };
  if (params.has("invite")) return { channel: "invite" };
  if (!referrer) return { channel: "direct" };
  let host = "";
  try {
    host = new URL(referrer).hostname;
  } catch {
    return { channel: "direct" };
  }
  if (host === ownHost) return undefined;
  if (AI.test(host)) return { channel: "ai_assistant" };
  if (SEARCH.test(host)) return { channel: "search" };
  return { channel: "referral" };
}


/** Where a user first came from, when it was a day2 link: the experiment, and for ads the platform and the ad. */
export type CameFrom = { experiment: string; platform: string | null; ad: string | null };

/** "B-4.tiktok.v1" → { experiment: "B-4", platform: "tiktok", ad: "v1" }. */
export function cameFromTag(tag: string | null | undefined): CameFrom | null {
  if (!tag || !/^[A-Za-z0-9._-]{1,40}$/.test(tag)) return null;
  const [experiment, platform, ad] = tag.split(".");
  return experiment ? { experiment, platform: platform || null, ad: ad || null } : null;
}
