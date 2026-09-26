import { describe, expect, test } from "bun:test";
import { parseAppProfileFields, renderAppProfilePlainLanguage, type AppProfile } from "./onboarding";

const validJsonBlock = () => `Some exploration notes here.

APP_PROFILE_JSON:
\`\`\`json
{
  "purpose": "Tracks everyday expenses so users know where their money goes.",
  "targetUsers": "Individuals who want a lightweight expense log.",
  "featureMap": ["Add an expense", "View spend summary", "List/delete expenses"],
  "styleGuide": {"colors": ["#111827", "#f9fafb"], "framework": "Tailwind + shadcn/ui"},
  "toneOfVoice": "Casual and friendly.",
  "businessModel": null,
  "caveats": ["No payment code found, so businessModel is null."]
}
\`\`\``;

describe("parseAppProfileFields", () => {
  test("parses a well-formed agent transcript", () => {
    const result = parseAppProfileFields(validJsonBlock(), false);
    expect(result).not.toBeNull();
    expect(result?.purpose).toContain("Tracks everyday expenses");
    expect(result?.featureMap).toHaveLength(3);
    expect(result?.styleGuide).toEqual({
      colors: ["#111827", "#f9fafb"],
      framework: "Tailwind + shadcn/ui",
    });
    expect(result?.businessModel).toBeNull();
  });

  test("fails closed on isError, even with a well-formed JSON block", () => {
    expect(parseAppProfileFields(validJsonBlock(), true)).toBeNull();
  });

  test("fails closed when there is no APP_PROFILE_JSON marker", () => {
    expect(parseAppProfileFields("I looked around and it's an expense app.", false)).toBeNull();
  });

  test("fails closed on malformed JSON after the marker", () => {
    const text = "APP_PROFILE_JSON:\n```json\n{ not valid json\n```";
    expect(parseAppProfileFields(text, false)).toBeNull();
  });

  test("fails closed when a required string field is missing", () => {
    const text = `APP_PROFILE_JSON:
\`\`\`json
{
  "targetUsers": "Individuals.",
  "featureMap": [],
  "styleGuide": null,
  "toneOfVoice": null,
  "businessModel": null,
  "caveats": []
}
\`\`\``;
    expect(parseAppProfileFields(text, false)).toBeNull();
  });

  test("fails closed when featureMap contains a non-string", () => {
    const text = `APP_PROFILE_JSON:
\`\`\`json
{
  "purpose": "x",
  "targetUsers": "y",
  "featureMap": ["ok", 42],
  "styleGuide": null,
  "toneOfVoice": null,
  "businessModel": null,
  "caveats": []
}
\`\`\``;
    expect(parseAppProfileFields(text, false)).toBeNull();
  });

  test("fails closed when styleGuide is malformed (colors not an array)", () => {
    const text = `APP_PROFILE_JSON:
\`\`\`json
{
  "purpose": "x",
  "targetUsers": "y",
  "featureMap": [],
  "styleGuide": {"colors": "red", "framework": "Tailwind"},
  "toneOfVoice": null,
  "businessModel": null,
  "caveats": []
}
\`\`\``;
    expect(parseAppProfileFields(text, false)).toBeNull();
  });

  test("accepts a null styleGuide/toneOfVoice/businessModel rather than requiring them", () => {
    const text = `APP_PROFILE_JSON:
\`\`\`json
{
  "purpose": "x",
  "targetUsers": "y",
  "featureMap": [],
  "styleGuide": null,
  "toneOfVoice": null,
  "businessModel": null,
  "caveats": ["nothing much found"]
}
\`\`\``;
    const result = parseAppProfileFields(text, false);
    expect(result).not.toBeNull();
    expect(result?.styleGuide).toBeNull();
    expect(result?.toneOfVoice).toBeNull();
    expect(result?.businessModel).toBeNull();
  });

  test("fails closed when the transcript hit a cap and never reached the marker", () => {
    expect(parseAppProfileFields("(ran out of turns before finishing)", false)).toBeNull();
  });
});

describe("renderAppProfilePlainLanguage", () => {
  const baseProfile: AppProfile = {
    purpose: "Tracks everyday expenses.",
    targetUsers: "Individuals logging personal spend.",
    featureMap: ["Add an expense", "View spend summary"],
    styleGuide: { colors: ["#111827"], framework: "Tailwind" },
    toneOfVoice: "Casual.",
    businessModel: null,
    caveats: ["No payment code found."],
    competitors: null,
    currentState: { unresolvedSentryIssues: 3 },
    currentStateCaveat: "",
    scannedAt: "2026-09-26T00:00:00.000Z",
  };

  test("renders every real field into plain language", () => {
    const rendered = renderAppProfilePlainLanguage(baseProfile);
    expect(rendered).toContain("Tracks everyday expenses.");
    expect(rendered).toContain("Individuals logging personal spend.");
    expect(rendered).toContain("- Add an expense");
    expect(rendered).toContain("Tailwind, colors: #111827");
    expect(rendered).toContain("Casual.");
    expect(rendered).toContain("No payment/pricing code found.");
    expect(rendered).toContain("3 unresolved error(s) in Sentry.");
    expect(rendered).toContain("- No payment code found.");
  });

  test("falls back to honest not-detected text for null fields, not blank output", () => {
    const rendered = renderAppProfilePlainLanguage({
      ...baseProfile,
      styleGuide: null,
      toneOfVoice: null,
      currentState: null,
      currentStateCaveat: "Sentry not queried: SENTRY_AUTH_TOKEN is not set.",
    });
    expect(rendered).toContain("Not detected.");
    expect(rendered).toContain("Not enough UI copy to judge.");
    expect(rendered).toContain("Sentry not queried: SENTRY_AUTH_TOKEN is not set.");
  });

  test("renders an explicit empty-state line when no features were detected", () => {
    const rendered = renderAppProfilePlainLanguage({ ...baseProfile, featureMap: [] });
    expect(rendered).toContain("(none detected)");
  });
});
