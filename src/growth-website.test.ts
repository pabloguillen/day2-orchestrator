import { describe, expect, test } from "bun:test";
import { generateMarketingWebsite, parseWebsiteGenerationResult } from "./growth-website";
import type { AppProfile } from "./onboarding";
import type { WebsiteConfig } from "./spend-governance";
import type { ToolBinding } from "./growth-tools-config";

function makeAppProfile(overrides: Partial<AppProfile> = {}): AppProfile {
  return {
    purpose: "Track personal expenses",
    targetUsers: "Budget-conscious individuals",
    featureMap: ["expense entry", "categorization"],
    styleGuide: { colors: ["#1a1a1a", "#f5f5f5"], framework: "Tailwind" },
    toneOfVoice: "calm, plain-spoken, no hype",
    businessModel: null,
    caveats: [],
    competitors: null,
    currentState: null,
    currentStateCaveat: "not scanned",
    scannedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function makeToolBinding(overrides: Partial<ToolBinding> = {}): ToolBinding {
  return {
    capability: "website_generation",
    mcpServerName: "framer",
    serverConfig: { type: "http", url: "https://mcp.framer.example/v1" },
    allowedTools: ["generate_site"],
    enabled: true,
    connectedAccountRef: "expense-buddy-site",
    ...overrides,
  };
}

const MARKER = "WEBSITE_GENERATION_JSON:";

describe("generateMarketingWebsite — fail-closed preconditions", () => {
  test("returns not_enabled when websiteConfig.enabled is false, without calling the agent", async () => {
    const result = await generateMarketingWebsite(makeAppProfile(), { enabled: false }, makeToolBinding());
    expect(result).toEqual({ status: "not_enabled" });
  });

  test("returns not_enabled even when a real toolBinding is present — opt-in always wins first", async () => {
    const result = await generateMarketingWebsite(makeAppProfile(), { enabled: false }, makeToolBinding());
    expect(result.status).toBe("not_enabled");
  });

  test("returns blocked_by_unconnected_account when enabled but no toolBinding resolved", async () => {
    const result = await generateMarketingWebsite(makeAppProfile(), { enabled: true }, undefined);
    expect(result).toEqual({ status: "blocked_by_unconnected_account" });
  });

  test("fails closed to generation_failed when toneOfVoice is missing, without calling the agent", async () => {
    const result = await generateMarketingWebsite(
      makeAppProfile({ toneOfVoice: null }),
      { enabled: true },
      makeToolBinding(),
    );
    expect(result.status).toBe("generation_failed");
    if (result.status === "generation_failed") {
      expect(result.reason).toContain("toneOfVoice");
    }
  });

  test("fails closed to generation_failed when styleGuide is missing, without calling the agent", async () => {
    const result = await generateMarketingWebsite(
      makeAppProfile({ styleGuide: null }),
      { enabled: true },
      makeToolBinding(),
    );
    expect(result.status).toBe("generation_failed");
    if (result.status === "generation_failed") {
      expect(result.reason).toContain("styleGuide");
    }
  });
});

describe("parseWebsiteGenerationResult", () => {
  test("parses a well-formed generated result", () => {
    const text = `${MARKER}\n${JSON.stringify({
      status: "generated",
      pageContent: "Hero: A quiet, simple expense tracker.\nFeatures: add an expense...",
      templateUsed: "minimal-single-page",
      previewRef: "https://real-preview.example.com/site123",
    })}`;
    const result = parseWebsiteGenerationResult(text, 0.05);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.previewRef).toBe("https://real-preview.example.com/site123");
      expect(result.templateUsed).toBe("minimal-single-page");
      expect(result.pageContent).toContain("A quiet, simple expense tracker");
      expect(result.costUsd).toBe(0.05);
    }
  });

  test("parses an honest generation_failed result", () => {
    const text = `${MARKER}\n${JSON.stringify({ status: "generation_failed", reason: "grounding too thin" })}`;
    const result = parseWebsiteGenerationResult(text, 0);
    expect(result).toEqual({ status: "generation_failed", reason: "grounding too thin" });
  });

  test("fails closed to generation_failed when the marker is missing", () => {
    const result = parseWebsiteGenerationResult("no marker here", 0);
    expect(result.status).toBe("generation_failed");
  });

  test("fails closed to generation_failed on malformed JSON", () => {
    const result = parseWebsiteGenerationResult(`${MARKER}\nnot json {{{`, 0);
    expect(result.status).toBe("generation_failed");
  });

  test("fails closed to generation_failed when a required field (previewRef) is missing", () => {
    const text = `${MARKER}\n${JSON.stringify({ status: "generated", pageContent: "x", templateUsed: "y" })}`;
    const result = parseWebsiteGenerationResult(text, 0);
    expect(result.status).toBe("generation_failed");
  });

  test("fails closed to generation_failed when pageContent is empty", () => {
    const text = `${MARKER}\n${JSON.stringify({ status: "generated", pageContent: "", templateUsed: "y", previewRef: "z" })}`;
    const result = parseWebsiteGenerationResult(text, 0);
    expect(result.status).toBe("generation_failed");
  });

  test("an honest no-live-preview note in previewRef is accepted as-is, not treated as invalid", () => {
    const text = `${MARKER}\n${JSON.stringify({
      status: "generated",
      pageContent: "Hero copy here.",
      templateUsed: "minimal",
      previewRef: "no live preview — the connected tool did not return a verifiable URL",
    })}`;
    const result = parseWebsiteGenerationResult(text, 0.02);
    expect(result.status).toBe("generated");
    if (result.status === "generated") {
      expect(result.previewRef).toContain("no live preview");
    }
  });
});
