import type { GrowthEvent } from "./types";

const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.[a-z.]+|ecosia\.org|baidu\.com|yandex\.[a-z.]+|startpage\.com|qwant\.com)$/;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com)$/;

/** Where a visitor came from, from the URL that opened the app and the referrer. */
export function acquisitionFrom(url: string, referrer: string, ownHost: string): GrowthEvent["acquisition"] {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const d2 = params.get("d2");
  if (d2) return { campaignId: d2.slice(0, 40), channel: "paid" };
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

