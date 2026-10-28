import type { Arm } from "../growth-allocator";
import { checkAuthenticity, checkTruthfulClaims, type Creative } from "../growth-creative";
import { meteredQuery } from "../metered-query";
import type { AppProfile } from "../onboarding";
import type { AdCopy, CallToAction } from "./types";

/**
 * The words for an experiment's ads, written once for all platforms:
 * a few variants (each with the short forms platforms need), a script for
 * an AI presenter, search keywords, interests, and the markets to run in.
 * Every variant and the script go through day2's two independent checks
 * (truthful claims, authenticity) before anything is produced or spent.
 */

export type CopyVariant = {
  /** ≤ 40 characters. */
  headline: string;
  /** ≤ 30 characters (search ads, small placements). */
  shortHeadline: string;
  /** ≤ 125 characters. */
  body: string;
  /** ≤ 90 characters. */
  description: string;
  cta: CallToAction;
  /** On the image/video itself: ≤ 45 characters. */
  frameHeadline: string;
  /** Button text on the image/video: ≤ 18 characters. */
  frameCta: string;
  claims: string[];
};

export type AdCopyPlan = {
  audience: "consumer" | "business";
  variants: CopyVariant[];
  /** ≤ 75 words, spoken by an AI presenter as a narrator — never as a real customer. */
  script: string | null;
  keywords: string[];
  interests: string[];
  countries: string[];
  languages: string[];
};

export type CopyInput = {
  appName: string;
  profile: AppProfile;
  /** The experiment's idea. */
  angle: string;
  /** Who it's for, as the experiment says. */
  audience: string;
  link: string;
  /** Markets the owner set, if any (ISO codes); otherwise the writer proposes them from the app. */
  countries?: string[];
  languages?: string[];
};

const MARKER = "AD_COPY_JSON:";
const CTAS: CallToAction[] = ["learn_more", "sign_up", "download", "get_started"];
const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";

export function buildCopyPrompt(i: CopyInput): string {
  return `You write paid social and search ads for an app. Write for the experiment's idea below, in the language of the app's market.

The app: ${i.appName} — ${i.profile.purpose}
For: ${i.profile.targetUsers}
Real features (the ONLY things you may claim): ${i.profile.featureMap.join("; ")}
Business model: ${i.profile.businessModel ?? "not established — don't mention prices or 'free' unless a feature says so"}
Tone: ${i.profile.toneOfVoice ?? "plain and friendly"}
Experiment idea: ${i.angle}
Audience for this experiment: ${i.audience || i.profile.targetUsers}
Landing page: ${i.link}
${i.countries?.length ? `Markets (fixed): ${i.countries.join(", ")}; languages: ${(i.languages ?? []).join(", ")}` : "Markets: propose the countries and languages the app is clearly built for (from its language and audience); at most 5 countries."}

Write 2 variants that take different angles on the idea. Each has: headline (≤40 chars), shortHeadline (≤30), body (≤125, the primary text), description (≤90), cta (one of ${CTAS.join(", ")}), frameHeadline (≤45, printed on the image/video), frameCta (≤18, the button on the image/video, e.g. "Try it free" only if it is free), and claims (every factual claim the variant makes).
Also: a script (≤75 words) for an AI presenter who speaks as a narrator showing the app — never pretending to be a real customer, no invented results, numbers or reviews; keywords (8–15 search terms people with this need type); interests (3–8 interests or job functions of the audience); audience: "consumer" or "business".
Rules: specific and truthful; no invented numbers, testimonials, rankings or awards; no superlatives you can't prove; no shaming; nothing about health, finance or politics beyond what the app does.

End your final message with exactly this marker on its own line, followed by JSON and nothing after it:
${MARKER}
{"audience":"consumer","countries":["DE"],"languages":["de"],"variants":[{"headline":"","shortHeadline":"","body":"","description":"","cta":"sign_up","frameHeadline":"","frameCta":"","claims":[""]}],"script":"","keywords":[""],"interests":[""]}`;
}

const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Pure: reads the writer's answer; anything malformed is dropped. */
export function parseCopy(text: string, fixed?: { countries?: string[]; languages?: string[] }): AdCopyPlan | null {
  const i = text.lastIndexOf(MARKER);
  if (i === -1) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(i + MARKER.length).trim());
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const variants: CopyVariant[] = [];
  for (const v of Array.isArray(r.variants) ? r.variants.slice(0, 3) : []) {
    const x = (v ?? {}) as Record<string, unknown>;
    const cta = CTAS.includes(x.cta as CallToAction) ? (x.cta as CallToAction) : "learn_more";
    const c: CopyVariant = {
      headline: s(x.headline, 40),
      shortHeadline: s(x.shortHeadline, 30) || s(x.headline, 30),
      body: s(x.body, 125),
      description: s(x.description, 90),
      cta,
      frameHeadline: s(x.frameHeadline, 45) || s(x.headline, 45),
      frameCta: s(x.frameCta, 18) || "Learn more",
      claims: Array.isArray(x.claims) ? x.claims.map((c) => s(c, 200)).filter(Boolean).slice(0, 8) : [],
    };
    if (c.headline && c.body) variants.push(c);
  }
  if (!variants.length) return null;
  const list = (v: unknown, max: number, re?: RegExp) => (Array.isArray(v) ? v.map((x) => s(x, 60)).filter((x) => x && (!re || re.test(x))).slice(0, max) : []);
  const countries = fixed?.countries?.length ? fixed.countries : list(r.countries, 5, /^[A-Z]{2}$/);
  const languages = fixed?.languages?.length ? fixed.languages : list(r.languages, 3, /^[a-z]{2}$/);
  return {
    audience: r.audience === "business" ? "business" : "consumer",
    variants,
    script: s(r.script, 600) || null,
    keywords: list(r.keywords, 15),
    interests: list(r.interests, 8),
    countries: countries.length ? countries : ["US"],
    languages: languages.length ? languages : ["en"],
  };
}

/** Writes the copy (metered to the current credit context). */
export async function writeAdCopy(input: CopyInput): Promise<AdCopyPlan | null> {
  let text = "";
  let failed = false;
  try {
    for await (const m of meteredQuery("content_generation", "Ad copy")({
      prompt: buildCopyPrompt(input),
      options: { model: MODEL, permissionMode: "bypassPermissions", maxTurns: 3, maxBudgetUsd: 0.5, persistSession: false, settingSources: [], settings: { disableClaudeAiConnectors: true }, tools: [] },
    })) {
      const msg = m as { type?: string; result?: string; is_error?: boolean };
      if (msg.type === "result") {
        text = msg.result ?? "";
        failed = Boolean(msg.is_error);
      }
    }
  } catch {
    failed = true;
  }
  return failed ? null : parseCopy(text, { countries: input.countries, languages: input.languages });
}

const ARM = (video: boolean, ugc: boolean): Arm => ({ channel: "paid_ads" as Arm["channel"], assetType: video ? "video" : "image", ...(video ? { videoFormat: ugc ? "ugc" : "motion_graphics" } : {}), formatTag: ugc ? "ai-presenter" : "app-frame" });
const asCreative = (headline: string, body: string, claims: string[], ugc: boolean): Creative => ({ arm: ARM(ugc, ugc), segment: "", headline, body, claimsCheckedAgainst: claims, costUsd: 0 });

export type CheckedCopy = { plan: AdCopyPlan; dropped: Array<{ what: string; why: string }> };

type Checks = { truthful: typeof checkTruthfulClaims; authentic: typeof checkAuthenticity };

/** Runs both independent checks on every variant and the script; keeps what passes. */
export async function checkAdCopy(plan: AdCopyPlan, profile: AppProfile, checks: Checks = { truthful: checkTruthfulClaims, authentic: checkAuthenticity }): Promise<CheckedCopy> {
  const dropped: CheckedCopy["dropped"] = [];
  const pass = async (c: Creative, what: string) => {
    const [t, a] = await Promise.all([checks.truthful(c, profile), checks.authentic(c, profile)]);
    const reasons = [
      ...(!t.truthful ? t.issues : []),
      ...(t.fabricatesTestimonialIdentity ? ["presents itself as a real customer"] : []),
      ...(a.readsAsGeneric ? [`reads as generic AI copy${a.matchedPatterns.length ? ` (${a.matchedPatterns.join(", ")})` : ""}`] : []),
    ];
    if (reasons.length) dropped.push({ what, why: reasons.join("; ") });
    return reasons.length === 0;
  };
  const variants: CopyVariant[] = [];
  for (const [n, v] of plan.variants.entries()) {
    if (await pass(asCreative(v.headline, `${v.body} ${v.description} — on the ad: "${v.frameHeadline}" / "${v.frameCta}"`, v.claims, false), `variant ${n + 1}`)) variants.push(v);
  }
  const script = plan.script && (await pass(asCreative(plan.variants[0]?.headline ?? "", plan.script, plan.variants.flatMap((v) => v.claims), true), "presenter script")) ? plan.script : null;
  return { plan: { ...plan, variants, script }, dropped };
}

/** One variant's copy for the platform contract. */
export function toAdCopy(v: CopyVariant): AdCopy {
  return { headline: v.headline, body: v.body, description: v.description, cta: v.cta };
}
