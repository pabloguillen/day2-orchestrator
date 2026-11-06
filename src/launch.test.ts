import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { existingIntegration, installItem } from "./field-work";
import { isLaunchKey, launchChecklist, type LaunchInput } from "./launch";

/** An Expo app that wired day2 in by hand, key and address from env variables (like Dotty). */
function handWiredApp(easEnv: Record<string, string> = {}) {
  const repo = mkdtempSync(join(tmpdir(), "day2-launch-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { expo: "58.0.0" } }));
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  mkdirSync(join(repo, "src", "vendor", "day2"), { recursive: true });
  writeFileSync(join(repo, "src", "vendor", "day2", "native.js"), "export function startDay2(o) {}");
  writeFileSync(
    join(repo, "src", "lib", "day2.ts"),
    "const key = process.env.EXPO_PUBLIC_DAY2_KEY ?? '';\nconst endpoint = process.env.EXPO_PUBLIC_DAY2_ENDPOINT ?? '';\nexport const day2 = startDay2({ key, endpoint });",
  );
  writeFileSync(join(repo, "eas.json"), JSON.stringify({ build: { production: { env: easEnv } } }));
  return repo;
}

describe("an integration wired in by hand", () => {
  test("found, with its env variables — and day2 doesn't propose a second copy", () => {
    const repo = handWiredApp();
    expect(existingIntegration(repo)).toEqual({ file: "src/lib/day2.ts", envKey: "EXPO_PUBLIC_DAY2_KEY", envEndpoint: "EXPO_PUBLIC_DAY2_ENDPOINT", envSetForRelease: false, identify: false });
    const app: AppEntry = { id: "app_d", name: "Dotty", repoPath: repo, connectionMethod: "local_path", addedAt: "" };
    expect(installItem(app, { key: "d2k_x", endpoint: "https://day2.example", candidates: [] })).toBeNull();
    expect(existingIntegration(handWiredApp({ EXPO_PUBLIC_DAY2_KEY: "d2k_x", EXPO_PUBLIC_DAY2_ENDPOINT: "https://day2.example" }))!.envSetForRelease).toBe(true);
  });

  test("an install ticket never gets a local address", () => {
    const repo = mkdtempSync(join(tmpdir(), "day2-launch-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { react: "19" } }));
    const app: AppEntry = { id: "a", name: "A", repoPath: repo, connectionMethod: "local_path", addedAt: "" };
    expect(installItem(app, { key: "d2k_x", endpoint: "http://localhost:3000", candidates: [] })).toBeNull();
    expect(installItem(app, { key: "d2k_x", endpoint: "https://day2.example", candidates: [] })).not.toBeNull();
  });
});

const base = (over: Partial<LaunchInput> = {}): LaunchInput => ({
  appId: "app_d",
  kind: "react-native",
  publicUrl: "http://localhost:3000",
  ingestKey: "d2k_abc",
  field: { reporting: false, installTicket: null, existing: { file: "src/lib/day2.ts", envKey: "EXPO_PUBLIC_DAY2_KEY", envEndpoint: "EXPO_PUBLIC_DAY2_ENDPOINT", envSetForRelease: false, identify: true } },
  privacy: { applies: true, stores: [{ store: "ios", upToDate: false, steps: [] }, { store: "android", upToDate: true, steps: [] }], notice: { upToDate: true, found: { path: "src/legal/texts.ts" }, ticket: null } },
  releases: null,
  ads: null,
  ...over,
});

describe("the launch checklist", () => {
  test("a mobile app on a local day2: what's essential, and who does it", () => {
    const items = launchChecklist(base());
    expect(items.map((x) => [x.id, x.state, x.essential])).toEqual([
      ["public_address", "you", true],
      ["field_checks", "you", true],
      ["privacy_notice", "done", true],
      ["store_answers", "you", true],
    ]);
    expect(items[1]!.next).toContain("once day2 has a public address");
    expect(items[3]!.next).toContain("Update the App Store answers");
  });

  test("once public: the exact settings for release builds", () => {
    const items = launchChecklist(base({ publicUrl: "https://day2.example.com" }));
    expect(items[0]!.state).toBe("done");
    expect(items[1]!.next).toContain('"EXPO_PUBLIC_DAY2_KEY": "d2k_abc", "EXPO_PUBLIC_DAY2_ENDPOINT": "https://day2.example.com"');
  });

  test("a ticket waiting for review is the owner's step; reporting is done; optional parts only when turned on", () => {
    const items = launchChecklist(
      base({
        publicUrl: "https://day2.example.com",
        field: { reporting: true, installTicket: null, existing: null },
        privacy: { applies: true, stores: [], notice: { upToDate: false, found: { path: "x" }, ticket: { id: "D2-12", state: "to_approve" } } },
        releases: { enabled: true, codeGaps: 0, setupTicket: null, missingAccounts: ["App Store Connect"] },
      }),
    );
    expect(items.find((x) => x.id === "field_checks")!.state).toBe("done");
    expect(items.find((x) => x.id === "privacy_notice")).toMatchObject({ state: "you", next: "Review and merge D2-12." });
    expect(items.find((x) => x.id === "release_setup")).toMatchObject({ essential: false, state: "you", next: "Connect App Store Connect on Connect your stores.", to: "/apps/app_d/connect" });
    expect(items.some((x) => x.id === "ads_handoff")).toBe(false);
  });

  test("day2's pull request that turns it on: approving it is the owner's step", () => {
    const items = launchChecklist(base({ publicUrl: "https://day2.example.com", field: { ...base().field, turnOnTicket: { id: "D2-14", state: "to_approve" } } }));
    expect(items[1]).toMatchObject({ state: "you", ticket: { id: "D2-14" } });
    expect(items[1]!.next).toContain("Approve D2-14");
  });

  test("launch tickets are recognised by their source", () => {
    expect(isLaunchKey("field:install")).toBe(true);
    expect(isLaunchKey("field:turn-on")).toBe(true);
    expect(isLaunchKey("privacy-notice:update:ab12")).toBe(true);
    expect(isLaunchKey("ads:website-handoff:day2.example.com")).toBe(true);
    expect(isLaunchKey("loop:sitemap")).toBe(false);
  });
});
