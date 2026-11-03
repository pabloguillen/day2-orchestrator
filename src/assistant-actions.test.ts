import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "./apps-registry";
import { ASSISTANT_KEY, actionsFromCode, actionsFromPlan, actionsFromUsage, assistantActionsPass, assistantActionsTicket, deepLinkApp, PLUGIN_PATH, routesFromCode } from "./assistant-actions";
import type { ContractHealth, FieldStore } from "./field-store";
import type { ContractFile } from "../packages/sensors/src/types";

const ROOT = mkdtempSync(join(tmpdir(), "day2-assistant-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function expoApp(name: string, appJson: Record<string, unknown> = { expo: { name: "Habit Loop", scheme: "habitloop", ios: { bundleIdentifier: "com.x.habitloop" }, android: { package: "com.x.habitloop" } } }): AppEntry {
  const dir = join(ROOT, name);
  mkdirSync(join(dir, "app", "(tabs)"), { recursive: true });
  mkdirSync(join(dir, "app", "habit"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "57", "react-native": "1" } }));
  writeFileSync(join(dir, "app.json"), JSON.stringify(appJson));
  for (const f of ["_layout.tsx", "+not-found.tsx", "settings.tsx", "(tabs)/index.tsx", "(tabs)/log.tsx", "(tabs)/history.tsx", "(tabs)/_layout.tsx", "habit/[id].tsx"]) writeFileSync(join(dir, "app", f), "export default () => null");
  return { id: name, name, repoPath: dir, connectionMethod: "local_path", addedAt: new Date().toISOString() };
}

const h = (contract: string, passes: number): ContractHealth => ({ contract, passes, failures: 0, rejected: 0, devices: 1, simulated: 0, firstFailureAt: null, lastFailureAt: null, sample: null }) as ContractHealth;
const contracts: ContractFile = {
  version: 1,
  generatedAt: "",
  contracts: [
    { id: "screen:/history", kind: "screen", route: "/history", source: "code" },
    { id: "screen:/settings", kind: "screen", route: "/settings", source: "code" },
    { id: "log.save", kind: "action", target: "action:log.save", expect: [{ screen: "/log" }], source: "code" },
    { id: "screen:/habit/[id]", kind: "screen", route: "/habit/[id]", source: "code" },
  ],
} as unknown as ContractFile;

describe("assistant actions", () => {
  test("routes from Expo Router's app folder (groups dropped, layouts skipped)", () => {
    const app = expoApp("routes");
    expect(routesFromCode(app.repoPath)).toEqual(["/", "/habit/[id]", "/history", "/log", "/settings"]);
    expect(actionsFromCode(routesFromCode(app.repoPath)).map((a) => a.route)).toEqual(["/history", "/log"]);
  });

  test("most used first, from field data; settings and dynamic routes are not actions", () => {
    const routes = ["/", "/history", "/log", "/settings", "/habit/[id]"];
    const a = actionsFromUsage([h("screen:/history", 5), h("log.save", 40), h("screen:/settings", 99), h("screen:/habit/[id]", 80)], contracts, routes);
    expect(a.map((x) => [x.route, x.uses])).toEqual([["/log", 40], ["/history", 5]]);
    expect(a[0]!.title).toBe("Open Log");
    expect(actionsFromPlan({ actions: [{ title: "Log a habit", route: "/log", phrase: "Log a habit" }, { title: "Open habit", route: "/habit/[id]" }] })).toEqual([{ id: "log_a_habit", title: "Log a habit", route: "/log", phrase: "Log a habit" }]);
  });

  test("only Expo apps with a deep link scheme", () => {
    expect(deepLinkApp(expoApp("dl").repoPath)).toEqual({ name: "Habit Loop", scheme: "habitloop", bundleId: "com.x.habitloop", androidPackage: "com.x.habitloop" });
    expect(deepLinkApp(expoApp("noscheme", { expo: { name: "x" } }).repoPath)).toBeNull();
    const web = join(ROOT, "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "package.json"), JSON.stringify({ dependencies: { react: "19" } }));
    expect(deepLinkApp(web)).toBeNull();
  });

  test("the ticket: precise native instructions, a native release, how it's verified", () => {
    const t = assistantActionsTicket({ name: "Habit Loop", scheme: "habitloop", bundleId: "com.x.h", androidPackage: "com.x.h" }, [{ id: "log", title: "Log a habit", route: "/log", phrase: "Log a habit" }], "create");
    expect(t).toMatchObject({ type: "feature", source: { kind: "day2_proposal", key: ASSISTANT_KEY } });
    expect(t.description).toContain("habitloop://log");
    expect(t.description).toContain("AppShortcutsProvider");
    expect(t.description).toContain("\\(.applicationName)");
    expect(t.description).toContain('android:targetClass="com.x.h.MainActivity"');
    expect(t.description).toContain("android.app.shortcuts");
    expect(t.description).toContain("native foundations");
    expect(t.description).toContain("openLink");
    expect(t.doneWhen.join(" ")).toContain(PLUGIN_PATH);
  });

  test("the autopilot proposes it once, from usage when there is some", async () => {
    const app = expoApp("pass");
    const field = { health: async () => [h("log.save", 12)], contracts: async () => ({ file: contracts, candidates: [], head: null, generatedAt: "" }) } as unknown as FieldStore;
    const id = await assistantActionsPass(app, { field });
    expect(id).toBe("D2-1");
    const backlog = JSON.parse(readFileSync(join(app.repoPath, "day2-backlog.json"), "utf-8"));
    expect(backlog.tickets[0].description).toContain("from day2's field data");
    expect(backlog.tickets[0].description).toContain("habitloop://log");
    expect(await assistantActionsPass(app, { field })).toBeNull(); // already proposed

    const web = expoApp("has-plugin", { expo: { scheme: "x", plugins: [PLUGIN_PATH] } });
    expect(await assistantActionsPass(web)).toBeNull(); // already built
    expect(await assistantActionsPass(expoApp("noscheme2", { expo: { name: "x" } }))).toBeNull();
  });
});
