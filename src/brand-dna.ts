/**
 * Brand DNA — the part of the app profile every outward-facing piece of
 * content is written from: ads, social posts, the marketing website, trend
 * campaigns, email and direct outreach. `toneOfVoice`/`styleGuide` (the
 * profile's original one-liners) stay as the mandatory grounding gate; this
 * adds the depth a copywriter or designer would actually need: who exactly
 * we talk to and what they care about, how the brand sounds (and must never
 * sound), what it looks like, and per-channel notes.
 *
 * Produced by the onboarding scan from the repo (README, UI copy, theme
 * config) and then confirmed/edited by the owner — the owner's edited
 * version is the source of truth. Everything here is owner-trusted once
 * saved (same trust tier as the rest of `AppProfile`).
 */

export type BrandColor = { hex: string; role: string };

export type BrandDna = {
  /** One sentence: what the app promises, for whom, versus the alternative. */
  positioning: string;
  /** 3–5 adjectives, e.g. ["calm", "practical", "a little playful"]. */
  personality: string[];
  audience: {
    /** The primary target group in one sentence. */
    primary: string;
    /** Distinct sub-groups worth addressing separately. */
    segments: string[];
    painPoints: string[];
    motivations: string[];
  };
  voice: {
    /** How the brand sounds, in a sentence. */
    tone: string;
    doSay: string[];
    dontSay: string[];
    /** Real lines quoted from the app's own copy, as reference. */
    sampleLines: string[];
  };
  visual: {
    palette: BrandColor[];
    typography: string | null;
    /** Photo/illustration/screenshot style. */
    imagery: string | null;
    /** Shapes, density, radius, motion — the overall design language. */
    designLanguage: string | null;
  };
  /** Channel-specific guidance; null where there's nothing specific to say. */
  channels: {
    ads: string | null;
    social: string | null;
    email: string | null;
    outreach: string | null;
  };
};

const MAX_ITEMS = 12;
const MAX_TEXT = 600;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function text(v: unknown, required: boolean): string | null | undefined {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return required ? undefined : null;
  if (typeof v !== "string") return undefined;
  return v.trim().slice(0, MAX_TEXT);
}

function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return undefined;
  return (v as string[])
    .map((x) => x.trim().slice(0, MAX_TEXT))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Pure validator/normalizer. Returns null for anything malformed rather
 * than a half-filled object — callers decide whether that's a hard error
 * (an owner's PUT) or a caveat (an agent scan that got the brand wrong but
 * the rest of the profile right). Trims strings, caps list lengths, drops
 * palette entries that aren't real hex colors.
 */
export function parseBrandDna(raw: unknown): BrandDna | null {
  const b = obj(raw);
  if (!b) return null;
  const audience = obj(b.audience);
  const voice = obj(b.voice);
  const visual = obj(b.visual);
  const channels = obj(b.channels) ?? {};
  if (!audience || !voice || !visual) return null;

  const positioning = text(b.positioning, true);
  const personality = list(b.personality);
  const primary = text(audience.primary, true);
  const segments = list(audience.segments);
  const painPoints = list(audience.painPoints);
  const motivations = list(audience.motivations);
  const tone = text(voice.tone, true);
  const doSay = list(voice.doSay);
  const dontSay = list(voice.dontSay);
  const sampleLines = list(voice.sampleLines);
  const typography = text(visual.typography, false);
  const imagery = text(visual.imagery, false);
  const designLanguage = text(visual.designLanguage, false);
  const ads = text(channels.ads, false);
  const social = text(channels.social, false);
  const email = text(channels.email, false);
  const outreach = text(channels.outreach, false);

  if (
    !positioning ||
    !primary ||
    !tone ||
    personality === undefined ||
    segments === undefined ||
    painPoints === undefined ||
    motivations === undefined ||
    doSay === undefined ||
    dontSay === undefined ||
    sampleLines === undefined ||
    typography === undefined ||
    imagery === undefined ||
    designLanguage === undefined ||
    ads === undefined ||
    social === undefined ||
    email === undefined ||
    outreach === undefined
  ) {
    return null;
  }

  const rawPalette = visual.palette ?? [];
  if (!Array.isArray(rawPalette)) return null;
  const palette: BrandColor[] = [];
  for (const c of rawPalette) {
    const o = obj(c);
    if (!o || typeof o.hex !== "string" || !HEX.test(o.hex.trim())) continue;
    palette.push({ hex: o.hex.trim().toLowerCase(), role: typeof o.role === "string" ? o.role.trim().slice(0, 80) : "" });
    if (palette.length >= MAX_ITEMS) break;
  }

  return {
    positioning,
    personality,
    audience: { primary, segments, painPoints, motivations },
    voice: { tone, doSay, dontSay, sampleLines },
    visual: { palette, typography, imagery, designLanguage },
    channels: { ads, social, email, outreach },
  };
}

export type BrandChannel = keyof BrandDna["channels"];

/** Maps a growth channel (growth-strategy.ts's `GrowthChannel`) to the
 * brand-guidance slot that applies to it, if any. */
export function brandChannelFor(growthChannel: string): BrandChannel | null {
  switch (growthChannel) {
    case "paid_ads":
      return "ads";
    case "social_content":
    case "referral_loops":
      return "social";
    case "direct_outreach":
      return "outreach";
    case "email":
      return "email";
    default:
      return null;
  }
}

function bullets(label: string, items: string[]): string[] {
  return items.length ? [`- ${label}: ${items.join("; ")}`] : [];
}

/**
 * Plain-text brief for generation prompts. With `channel`, only that
 * channel's note is included (so an email isn't written to ad guidance).
 * Returns "" when there's no brand DNA — callers keep working from the
 * original toneOfVoice/styleGuide grounding exactly as before.
 */
export function renderBrandBrief(brand: BrandDna | null | undefined, channel?: BrandChannel | null): string {
  if (!brand) return "";
  const lines: string[] = ["Brand DNA (confirmed by the owner — follow it):"];
  lines.push(`- Positioning: ${brand.positioning}`);
  lines.push(...bullets("Personality", brand.personality));
  lines.push(`- Primary audience: ${brand.audience.primary}`);
  lines.push(...bullets("Audience segments", brand.audience.segments));
  lines.push(...bullets("Their pain points", brand.audience.painPoints));
  lines.push(...bullets("What motivates them", brand.audience.motivations));
  lines.push(`- Voice: ${brand.voice.tone}`);
  lines.push(...bullets("Do say / do", brand.voice.doSay));
  lines.push(...bullets("Never say / never do", brand.voice.dontSay));
  if (brand.voice.sampleLines.length) {
    lines.push(`- Real lines from the app (match this register): ${brand.voice.sampleLines.map((l) => `"${l}"`).join(" ")}`);
  }
  if (brand.visual.palette.length) {
    lines.push(`- Palette: ${brand.visual.palette.map((c) => (c.role ? `${c.hex} (${c.role})` : c.hex)).join(", ")}`);
  }
  if (brand.visual.typography) lines.push(`- Typography: ${brand.visual.typography}`);
  if (brand.visual.imagery) lines.push(`- Imagery: ${brand.visual.imagery}`);
  if (brand.visual.designLanguage) lines.push(`- Design language: ${brand.visual.designLanguage}`);
  const note = channel ? brand.channels[channel] : null;
  if (note) lines.push(`- For this channel (${channel}): ${note}`);
  return lines.join("\n");
}
