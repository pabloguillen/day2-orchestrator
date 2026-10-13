import { describe, expect, test } from "bun:test";
import { brandChannelFor, parseBrandDna, renderBrandBrief } from "./brand-dna";
import { parseAppProfileFields } from "./onboarding";

const valid = {
  positioning: "  Split shared bills in seconds, without the awkward chasing.  ",
  personality: ["calm", "practical", " "],
  audience: {
    primary: "Flatmates in their twenties sharing rent and groceries",
    segments: ["students", "young professionals"],
    painPoints: ["chasing friends for money"],
    motivations: ["keep friendships easy"],
  },
  voice: {
    tone: "Friendly and brief",
    doSay: ["use 'you'"],
    dontSay: ["guilt-tripping"],
    sampleLines: ["Who was there?"],
  },
  visual: {
    palette: [
      { hex: "#0F766E", role: "primary" },
      { hex: "teal", role: "not a hex" },
    ],
    typography: "Inter for everything",
    imagery: null,
    designLanguage: "Rounded cards, generous spacing",
  },
  channels: { ads: "Lead with the receipt snap", social: null, email: "", outreach: "Personal, one ask" },
};

describe("parseBrandDna", () => {
  test("normalizes: trims, drops blank items, drops non-hex colors, lowercases hex, empty → null", () => {
    const b = parseBrandDna(valid)!;
    expect(b.positioning).toBe("Split shared bills in seconds, without the awkward chasing.");
    expect(b.personality).toEqual(["calm", "practical"]);
    expect(b.visual.palette).toEqual([{ hex: "#0f766e", role: "primary" }]);
    expect(b.channels.email).toBeNull();
    expect(b.visual.imagery).toBeNull();
  });

  test("rejects a brand without positioning, primary audience or voice tone", () => {
    expect(parseBrandDna({ ...valid, positioning: "" })).toBeNull();
    expect(parseBrandDna({ ...valid, audience: { ...valid.audience, primary: " " } })).toBeNull();
    expect(parseBrandDna({ ...valid, voice: { ...valid.voice, tone: 3 } })).toBeNull();
    expect(parseBrandDna(null)).toBeNull();
    expect(parseBrandDna("brand")).toBeNull();
  });

  test("rejects wrongly typed lists rather than guessing", () => {
    expect(parseBrandDna({ ...valid, personality: "calm" })).toBeNull();
  });

  test("caps list lengths", () => {
    const many = Array.from({ length: 30 }, (_, i) => `s${i}`);
    expect(parseBrandDna({ ...valid, audience: { ...valid.audience, segments: many } })!.audience.segments).toHaveLength(12);
  });
});

describe("brandChannelFor / renderBrandBrief", () => {
  test("maps growth channels to brand channel slots", () => {
    expect(brandChannelFor("paid_ads")).toBe("ads");
    expect(brandChannelFor("social_content")).toBe("social");
    expect(brandChannelFor("direct_outreach")).toBe("outreach");
    expect(brandChannelFor("seo_content")).toBeNull();
  });

  test("includes only the requested channel's note", () => {
    const b = parseBrandDna(valid)!;
    const ads = renderBrandBrief(b, "ads");
    expect(ads).toContain("For this channel (ads): Lead with the receipt snap");
    expect(ads).not.toContain("Personal, one ask");
    expect(ads).toContain("Never say / never do: guilt-tripping");
    expect(ads).toContain('"Who was there?"');
  });

  test("is empty without brand DNA, so callers fall back to the old grounding", () => {
    expect(renderBrandBrief(null)).toBe("");
    expect(renderBrandBrief(undefined)).toBe("");
  });
});

describe("parseAppProfileFields with brand DNA", () => {
  const base = {
    purpose: "Split bills",
    targetUsers: "Flatmates",
    featureMap: ["Scan receipt"],
    styleGuide: null,
    toneOfVoice: "friendly",
    businessModel: null,
    caveats: ["no style system"],
  };
  const wrap = (o: object) => `done\nAPP_PROFILE_JSON:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

  test("keeps a valid brand", () => {
    expect(parseAppProfileFields(wrap({ ...base, brand: valid }), false)?.brand?.voice.tone).toBe("Friendly and brief");
  });

  test("a malformed brand costs only the brand, with a caveat — not the profile", () => {
    const r = parseAppProfileFields(wrap({ ...base, brand: { positioning: "x" } }), false);
    expect(r).not.toBeNull();
    expect(r!.brand).toBeNull();
    expect(r!.caveats.some((c) => c.includes("Brand DNA"))).toBe(true);
  });

  test("profiles without a brand key still parse (brand: null)", () => {
    expect(parseAppProfileFields(wrap(base), false)?.brand).toBeNull();
  });
});
