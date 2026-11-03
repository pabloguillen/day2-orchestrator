import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../api-server";
import { BACKLOG_FILENAME } from "../backlog";

/**
 * The Live API through the real router in local mode: settings, an
 * experiment written by the owner, start, stop, keep a winner, autonomy,
 * and the config an app gets with its key. No agent calls, no network.
 */

const ROOT = mkdtempSync(join(tmpdir(), "day2-api-live-"));
const REPO = join(ROOT, "dotty");
const saved: Record<string, string | undefined> = {};
let appId = "";

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handleRequest(
    new Request(`http://localhost:4700${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  for (const k of ["DAY2_APPS_REGISTRY_PATH", "DAY2_DATA_DIR", "DAY2_BACKLOG_TICK_MINUTES"]) saved[k] = process.env[k];
  process.env.DAY2_APPS_REGISTRY_PATH = join(ROOT, "apps.json");
  process.env.DAY2_DATA_DIR = ROOT;
  mkdirSync(join(REPO, "app"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "dotty", dependencies: { expo: "54.0.0", "react-native": "0.81.0" } }));
  writeFileSync(join(REPO, "app/index.tsx"), 'export default () => useDay2Value("onboarding.title", "Welcome");');
  execSync("git init -q", { cwd: REPO });
  const r = await call("POST", "/api/apps", { name: "Dotty", repoPath: REPO, connectionMethod: "local_path" });
  expect(r.status).toBe(201);
  appId = r.body.app.id;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

const EXP = {
  title: "Shorter welcome",
  hypothesis: "Shorter is friendlier.",
  keys: ["onboarding.title"],
  variants: [
    { name: "control", weight: 50, values: {} },
    { name: "short", weight: 50, values: { "onboarding.title": "Hi" } },
  ],
  metric: { kind: "event", event: "dot_added" },
};

describe("Live API", () => {
  test("settings: set, used by the app's config, removed", async () => {
    const empty = await call("GET", `/api/apps/${appId}/live`);
    expect(empty.body).toMatchObject({ values: [], experiments: [], codeKeys: ["onboarding.title"], settings: { autonomy: "day2_decides", maxActive: 2 } });
    const set = await call("PUT", `/api/apps/${appId}/live/values/paywall.trial_days`, { value: 7, note: "Free trial length" });
    expect(set.status).toBe(200);
    expect(set.body.values).toEqual([expect.objectContaining({ key: "paywall.trial_days", value: 7, by: "owner", inCode: false, note: "Free trial length" })]);
    expect(set.body.log[0].text).toContain("Apps get it on their next launch");
    expect((await call("PUT", `/api/apps/${appId}/live/values/1bad`, { value: 1 })).status).toBe(400);

    // The app asks with its key.
    const key = (await call("GET", `/api/apps/${appId}/field`)).body.key as string;
    expect(key).toStartWith("d2k_");
    {
      const cfg = await call("GET", `/api/ingest/${key}/config?p=ios`);
      expect(cfg.status).toBe(200);
      expect(cfg.body.values).toEqual({ "paywall.trial_days": 7 });
      const again = await call("GET", `/api/ingest/${key}/config?p=ios`, undefined, { "if-none-match": cfg.headers.get("etag")! });
      expect(again.status).toBe(304);
    }
    const del = await call("DELETE", `/api/apps/${appId}/live/values/paywall.trial_days`);
    expect(del.body.values).toEqual([]);
  });

  test("an owner's experiment: written down, started (settings-only: at once), kept", async () => {
    const bad = await call("POST", `/api/apps/${appId}/live/experiments`, { ...EXP, variants: [{ name: "a", weight: 1, values: {} }, { name: "b", weight: 1, values: {} }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("control");
    const made = await call("POST", `/api/apps/${appId}/live/experiments`, EXP);
    expect(made.body.experiments[0]).toMatchObject({ id: "X-1", state: "draft", configOnly: true, metricLabel: "share who dot added" });
    const started = await call("POST", `/api/apps/${appId}/live/experiments/X-1/start`);
    expect(started.body.experiments[0]).toMatchObject({ state: "running" });
    // No winner yet: can't keep one, unless the owner picks it.
    expect((await call("POST", `/api/apps/${appId}/live/experiments/X-1/promote`)).status).toBe(400);
    const kept = await call("POST", `/api/apps/${appId}/live/experiments/X-1/promote`, { winner: "short" });
    expect(kept.status).toBe(200);
    expect(kept.body.experiments[0].state).toBe("promoted");
    expect(kept.body.values).toEqual([expect.objectContaining({ key: "onboarding.title", value: "Hi", by: "experiment" })]);
  });

  test("an experiment on a setting the code doesn't read yet: a build ticket; stopping it", async () => {
    const r = await call("POST", `/api/apps/${appId}/live/experiments`, { ...EXP, keys: ["paywall.trial_days"], variants: [{ name: "control", weight: 50, values: {} }, { name: "long", weight: 50, values: { "paywall.trial_days": 14 } }] });
    const id = r.body.experiments[0].id as string;
    const started = await call("POST", `/api/apps/${appId}/live/experiments/${id}/start`);
    expect(started.body.experiments[0]).toMatchObject({ state: "building", configOnly: false });
    const tickets = JSON.parse(readFileSync(join(REPO, BACKLOG_FILENAME), "utf-8")).tickets as Array<{ id: string; source: { key: string } }>;
    expect(tickets.find((t) => t.source.key === `live:build:${id}`)?.id).toBe(started.body.experiments[0].ticketId);
    const stopped = await call("POST", `/api/apps/${appId}/live/experiments/${id}/stop`, { reason: "changed my mind" });
    expect(stopped.body.experiments[0]).toMatchObject({ state: "stopped", stopReason: "you stopped it (changed my mind)." });
  });

  test("autonomy setting", async () => {
    const r = await call("PUT", `/api/apps/${appId}/live/settings`, { autonomy: "ask_first", maxActive: 1 });
    expect(r.body.settings).toEqual({ autonomy: "ask_first", maxActive: 1 });
    expect(r.body.log[0].text).toContain("day2 asks you before");
  });
});
