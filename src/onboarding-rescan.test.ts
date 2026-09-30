import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffAppProfiles, loadStoredAppProfile, parseDriftSignificanceVerdict, writePendingAppProfile } from "./onboarding-rescan";
import type { AppProfile } from "./onboarding";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "day2-onboarding-rescan-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeProfile(overrides: Partial<AppProfile> = {}): AppProfile {
  return {
    purpose: "Track personal expenses",
    targetUsers: "Budget-conscious individuals",
    featureMap: ["expense entry", "categorization"],
    styleGuide: { colors: ["#1a1a1a"], framework: "Tailwind" },
    toneOfVoice: "calm, plain-spoken",
    businessModel: null,
    caveats: [],
    competitors: null,
    currentState: { unresolvedSentryIssues: 0 },
    currentStateCaveat: "0 unresolved",
    scannedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("loadStoredAppProfile", () => {
  test("returns null (not a throw) when no file exists", () => {
    withTempDir((dir) => {
      expect(loadStoredAppProfile(join(dir, ".day2-app-profile.json"))).toBeNull();
    });
  });

  test("loads a previously saved profile", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-app-profile.json");
      const profile = makeProfile();
      writeFileSync(path, JSON.stringify(profile));
      expect(loadStoredAppProfile(path)).toEqual(profile);
    });
  });

  test("returns null on malformed JSON rather than throwing", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-app-profile.json");
      writeFileSync(path, "{ not valid json");
      expect(loadStoredAppProfile(path)).toBeNull();
    });
  });
});

describe("writePendingAppProfile", () => {
  test("writes a real, readable pending file", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-app-profile.pending.json");
      const profile = makeProfile();
      writePendingAppProfile(path, profile);
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual(profile);
    });
  });
});

describe("diffAppProfiles", () => {
  test("null oldProfile (nothing reviewed yet) always counts as drift", () => {
    const diffs = diffAppProfiles(null, makeProfile());
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("first scan");
  });

  test("identical profiles produce no diff", () => {
    const profile = makeProfile();
    expect(diffAppProfiles(profile, { ...profile })).toEqual([]);
  });

  test("detects a purpose change", () => {
    const diffs = diffAppProfiles(makeProfile(), makeProfile({ purpose: "A completely different purpose" }));
    expect(diffs.some((d) => d.includes("purpose changed"))).toBe(true);
  });

  test("detects a styleGuide change", () => {
    const diffs = diffAppProfiles(
      makeProfile(),
      makeProfile({ styleGuide: { colors: ["#ff0000"], framework: "Bootstrap" } }),
    );
    expect(diffs.some((d) => d.includes("styleGuide changed"))).toBe(true);
  });

  test("detects a featureMap change", () => {
    const diffs = diffAppProfiles(makeProfile(), makeProfile({ featureMap: ["expense entry", "budgets", "reports"] }));
    expect(diffs.some((d) => d.includes("featureMap changed"))).toBe(true);
  });

  test("detects a toneOfVoice change", () => {
    const diffs = diffAppProfiles(makeProfile(), makeProfile({ toneOfVoice: "loud and playful" }));
    expect(diffs.some((d) => d.includes("toneOfVoice changed"))).toBe(true);
  });

  test("detects a businessModel change", () => {
    const diffs = diffAppProfiles(makeProfile({ businessModel: null }), makeProfile({ businessModel: "freemium" }));
    expect(diffs.some((d) => d.includes("businessModel changed"))).toBe(true);
  });

  test("does NOT flag a currentState/Sentry-count-only change as drift (deliberately excluded, would be pure noise)", () => {
    const diffs = diffAppProfiles(
      makeProfile({ currentState: { unresolvedSentryIssues: 0 } }),
      makeProfile({ currentState: { unresolvedSentryIssues: 7 } }),
    );
    expect(diffs).toEqual([]);
  });

  test("does NOT flag a scannedAt-only change as drift (metadata, not grounding content)", () => {
    const diffs = diffAppProfiles(
      makeProfile({ scannedAt: "2026-09-26T10:51:49.007Z" }),
      makeProfile({ scannedAt: "2026-09-30T15:00:00.000Z" }),
    );
    expect(diffs).toEqual([]);
  });

  test("accumulates multiple real diffs at once, not just the first one found", () => {
    const diffs = diffAppProfiles(
      makeProfile(),
      makeProfile({ purpose: "New purpose", toneOfVoice: "New tone" }),
    );
    expect(diffs).toHaveLength(2);
  });
});

const SIGNIFICANCE_MARKER = "DRIFT_SIGNIFICANCE_JSON:";

describe("parseDriftSignificanceVerdict", () => {
  test("parses a genuine, real-change verdict", () => {
    const text = `${SIGNIFICANCE_MARKER}\n${JSON.stringify({ significant: true, reasoning: "a real new feature was added" })}`;
    const verdict = parseDriftSignificanceVerdict(text);
    expect(verdict.significant).toBe(true);
  });

  test("parses a just-rewording verdict", () => {
    const text = `${SIGNIFICANCE_MARKER}\n${JSON.stringify({ significant: false, reasoning: "same features, just different phrasing" })}`;
    const verdict = parseDriftSignificanceVerdict(text);
    expect(verdict.significant).toBe(false);
  });

  test("fails closed to significant: true when the marker is missing", () => {
    const verdict = parseDriftSignificanceVerdict("no marker here");
    expect(verdict.significant).toBe(true);
  });

  test("fails closed to significant: true on malformed JSON", () => {
    const verdict = parseDriftSignificanceVerdict(`${SIGNIFICANCE_MARKER}\nnot json {{{`);
    expect(verdict.significant).toBe(true);
  });

  test("fails closed to significant: true on an invalid shape (missing reasoning)", () => {
    const text = `${SIGNIFICANCE_MARKER}\n${JSON.stringify({ significant: false })}`;
    const verdict = parseDriftSignificanceVerdict(text);
    expect(verdict.significant).toBe(true);
  });
});
