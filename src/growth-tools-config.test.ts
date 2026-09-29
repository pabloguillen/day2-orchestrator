import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMcpServersOption,
  loadGrowthToolsConfig,
  parseToolCandidateInsights,
  resolveBindings,
  selectBestFitBinding,
} from "./growth-tools-config";
import type { Arm, GrowthToolsConfig, ToolBinding } from "./growth-tools-config";
import type { GrowthStrategy } from "./growth-strategy";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "day2-growth-tools-config-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeBinding(overrides: Partial<ToolBinding> = {}): ToolBinding {
  return {
    capability: "creative_generation",
    mcpServerName: "tryholo",
    serverConfig: { type: "http", url: "https://mcp.example.com/tryholo" },
    allowedTools: ["generate_creative"],
    enabled: true,
    ...overrides,
  };
}

function makeArm(overrides: Partial<Arm> = {}): Arm {
  return { channel: "social_content", assetType: "text", formatTag: "v1", ...overrides };
}

function makeStrategy(): GrowthStrategy {
  return {
    stage: "traction",
    stageBasis: "test",
    totalBudgetUsd: 100,
    allocations: [],
    paidAcquisitionUnlocked: false,
    unlockBasis: "test",
    kpiGoals: [],
    derivedAt: "2026-09-29T00:00:00.000Z",
  };
}

describe("loadGrowthToolsConfig", () => {
  test("returns a safe empty default (bindings: []) when no file exists", () => {
    withTempDir((dir) => {
      const config = loadGrowthToolsConfig(join(dir, ".day2-platform-tools.json"));
      expect(config.bindings).toEqual([]);
    });
  });

  test("round-trips a hand-authored config file", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-platform-tools.json");
      const config: GrowthToolsConfig = {
        bindings: [
          makeBinding({ capability: "competitor_research", mcpServerName: "foreplay" }),
          makeBinding({
            capability: "social_account_operation",
            mcpServerName: "posteverywhere",
            connectedAccountRef: "expense-buddy-instagram",
          }),
        ],
      };
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
      const loaded = loadGrowthToolsConfig(path);
      expect(loaded).toEqual(config);
    });
  });

  test("throws (refuses to guess) on invalid JSON", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-platform-tools.json");
      writeFileSync(path, "{ not valid json");
      expect(() => loadGrowthToolsConfig(path)).toThrow();
    });
  });

  test("throws on a structurally invalid config (unknown capability)", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-platform-tools.json");
      writeFileSync(path, JSON.stringify({ bindings: [{ ...makeBinding(), capability: "not_a_real_domain" }] }));
      expect(() => loadGrowthToolsConfig(path)).toThrow();
    });
  });

  test("throws on a binding missing a required field (serverConfig)", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-platform-tools.json");
      const bad = makeBinding() as Partial<ToolBinding>;
      delete bad.serverConfig;
      writeFileSync(path, JSON.stringify({ bindings: [bad] }));
      expect(() => loadGrowthToolsConfig(path)).toThrow();
    });
  });
});

describe("resolveBindings", () => {
  test("returns [] against the empty default", () => {
    const config: GrowthToolsConfig = { bindings: [] };
    expect(resolveBindings(config, "creative_generation", "expense-buddy")).toEqual([]);
  });

  test("filters by capability and enabled", () => {
    const config: GrowthToolsConfig = {
      bindings: [
        makeBinding({ capability: "creative_generation", enabled: true }),
        makeBinding({ capability: "seo_content", enabled: true }),
        makeBinding({ capability: "creative_generation", enabled: false }),
      ],
    };
    const resolved = resolveBindings(config, "creative_generation", "expense-buddy");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.enabled).toBe(true);
  });

  test("a non-identity capability resolves even with no connectedAccountRef", () => {
    const config: GrowthToolsConfig = { bindings: [makeBinding({ capability: "creative_generation" })] };
    expect(resolveBindings(config, "creative_generation", "expense-buddy")).toHaveLength(1);
  });

  test("an identity-bearing capability fails closed when connectedAccountRef is unset, even though enabled: true platform-wide", () => {
    const config: GrowthToolsConfig = {
      bindings: [makeBinding({ capability: "social_account_operation", mcpServerName: "posteverywhere", enabled: true })],
    };
    expect(resolveBindings(config, "social_account_operation", "expense-buddy")).toEqual([]);
  });

  test("an identity-bearing capability resolves once connectedAccountRef is set", () => {
    const config: GrowthToolsConfig = {
      bindings: [
        makeBinding({
          capability: "social_account_operation",
          mcpServerName: "posteverywhere",
          enabled: true,
          connectedAccountRef: "expense-buddy-instagram",
        }),
      ],
    };
    expect(resolveBindings(config, "social_account_operation", "expense-buddy")).toHaveLength(1);
  });

  test("all three identity-bearing capabilities fail closed without a connectedAccountRef", () => {
    for (const capability of ["social_account_operation", "ad_platform", "website_generation"] as const) {
      const config: GrowthToolsConfig = { bindings: [makeBinding({ capability, enabled: true })] };
      expect(resolveBindings(config, capability, "expense-buddy")).toEqual([]);
    }
  });
});

describe("selectBestFitBinding", () => {
  test("returns undefined for an empty candidate list", () => {
    expect(selectBestFitBinding([], { arm: makeArm(), strategy: makeStrategy() })).toBeUndefined();
  });

  test("returns the only candidate when there's exactly one", () => {
    const only = makeBinding();
    expect(selectBestFitBinding([only], { arm: makeArm(), strategy: makeStrategy() })).toBe(only);
  });

  test("falls back to the first binding when none declare fitHints", () => {
    const first = makeBinding({ mcpServerName: "higgsfield" });
    const second = makeBinding({ mcpServerName: "tryholo" });
    const result = selectBestFitBinding([first, second], { arm: makeArm(), strategy: makeStrategy() });
    expect(result).toBe(first);
  });

  test("picks the binding whose fitHints actually match the arm over one that doesn't", () => {
    const nonMatching = makeBinding({ mcpServerName: "higgsfield", fitHints: { assetTypes: ["image"] } });
    const matching = makeBinding({ mcpServerName: "tryholo", fitHints: { assetTypes: ["text"] } });
    const result = selectBestFitBinding([nonMatching, matching], {
      arm: makeArm({ assetType: "text" }),
      strategy: makeStrategy(),
    });
    expect(result).toBe(matching);
  });

  test("picks a UGC-specialized binding for a UGC arm over a generic video binding", () => {
    const generic = makeBinding({ mcpServerName: "raylight", fitHints: { videoFormats: ["motion_graphics"] } });
    const ugcSpecialist = makeBinding({ mcpServerName: "arcads", fitHints: { videoFormats: ["ugc"] } });
    const result = selectBestFitBinding([generic, ugcSpecialist], {
      arm: makeArm({ assetType: "video", videoFormat: "ugc" }),
      strategy: makeStrategy(),
    });
    expect(result).toBe(ugcSpecialist);
  });

  test("more matching fitHints dimensions beats fewer", () => {
    const oneMatch = makeBinding({ mcpServerName: "a", fitHints: { assetTypes: ["video"] } });
    const twoMatches = makeBinding({
      mcpServerName: "b",
      fitHints: { assetTypes: ["video"], channels: ["social_content"] },
    });
    const result = selectBestFitBinding([oneMatch, twoMatches], {
      arm: makeArm({ assetType: "video", channel: "social_content" }),
      strategy: makeStrategy(),
    });
    expect(result).toBe(twoMatches);
  });

  test("referral_loops is a valid Arm.channel/fitHints.channels value (W41 disclosed correction: GrowthChannel, not SpendCategory)", () => {
    const referralHinted = makeBinding({ mcpServerName: "referral-tool", fitHints: { channels: ["referral_loops"] } });
    const other = makeBinding({ mcpServerName: "other-tool", fitHints: { channels: ["paid_ads"] } });
    const result = selectBestFitBinding([other, referralHinted], {
      arm: makeArm({ channel: "referral_loops" }),
      strategy: makeStrategy(),
    });
    expect(result).toBe(referralHinted);
  });
});

describe("buildMcpServersOption", () => {
  test("returns {} when nothing is enabled for the requested capabilities", () => {
    const config: GrowthToolsConfig = { bindings: [makeBinding({ enabled: false })] };
    expect(buildMcpServersOption(config, ["creative_generation"])).toEqual({});
  });

  test("includes only enabled bindings matching a requested capability", () => {
    const config: GrowthToolsConfig = {
      bindings: [
        makeBinding({ capability: "creative_generation", mcpServerName: "tryholo", enabled: true }),
        makeBinding({ capability: "seo_content", mcpServerName: "semrush", enabled: true }),
        makeBinding({ capability: "creative_generation", mcpServerName: "higgsfield", enabled: false }),
      ],
    };
    const servers = buildMcpServersOption(config, ["creative_generation"]);
    expect(Object.keys(servers)).toEqual(["tryholo"]);
  });

  test("a single vendor bound to two requested capabilities collapses to one entry", () => {
    const junoServerConfig = { type: "http" as const, url: "https://mcp.example.com/juno" };
    const config: GrowthToolsConfig = {
      bindings: [
        makeBinding({ capability: "website_generation", mcpServerName: "juno", serverConfig: junoServerConfig, enabled: true }),
        makeBinding({ capability: "seo_content", mcpServerName: "juno", serverConfig: junoServerConfig, enabled: true }),
      ],
    };
    const servers = buildMcpServersOption(config, ["website_generation", "seo_content"]);
    expect(Object.keys(servers)).toEqual(["juno"]);
  });

  test("requesting multiple capabilities returns the union of their enabled bindings", () => {
    const config: GrowthToolsConfig = {
      bindings: [
        makeBinding({ capability: "creative_generation", mcpServerName: "tryholo", enabled: true }),
        makeBinding({ capability: "seo_content", mcpServerName: "semrush", enabled: true }),
      ],
    };
    const servers = buildMcpServersOption(config, ["creative_generation", "seo_content"]);
    expect(Object.keys(servers).sort()).toEqual(["semrush", "tryholo"]);
  });
});

describe("parseToolCandidateInsights", () => {
  test("returns [] when the marker is missing", () => {
    expect(parseToolCandidateInsights("no marker here", "competitor_research")).toEqual([]);
  });

  test("returns [] on malformed JSON after the marker", () => {
    expect(parseToolCandidateInsights("TOOL_CANDIDATES_JSON:\nnot json", "competitor_research")).toEqual([]);
  });

  test("parses a well-formed result and stamps the domain onto every entry", () => {
    const text = `Some reasoning.\nTOOL_CANDIDATES_JSON:\n${JSON.stringify([
      {
        toolName: "Foreplay",
        whatItDoes: "Competitor ad tracking",
        fitReason: "Real-time Meta/TikTok ad intelligence",
        mcpAvailability: "unknown",
        source: "https://foreplay.co",
      },
    ])}`;
    const parsed = parseToolCandidateInsights(text, "competitor_research");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.toolName).toBe("Foreplay");
    expect(parsed[0]!.domain).toBe("competitor_research");
  });

  test("drops individual malformed entries but keeps valid ones in the same batch", () => {
    const text = `TOOL_CANDIDATES_JSON:\n${JSON.stringify([
      { toolName: "Real Tool", whatItDoes: "x", fitReason: "y", mcpAvailability: "confirmed_mcp", source: "https://real.example.com" },
      { toolName: "", whatItDoes: "x", fitReason: "y", mcpAvailability: "confirmed_mcp", source: "https://bad.example.com" },
      { toolName: "Bad Availability", whatItDoes: "x", fitReason: "y", mcpAvailability: "not_a_real_value", source: "https://bad2.example.com" },
    ])}`;
    const parsed = parseToolCandidateInsights(text, "seo_content");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.toolName).toBe("Real Tool");
  });

  test("an honest empty array is accepted as-is, not treated as a parse failure", () => {
    expect(parseToolCandidateInsights("TOOL_CANDIDATES_JSON:\n[]", "ad_platform")).toEqual([]);
  });
});
