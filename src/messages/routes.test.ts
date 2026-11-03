import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEntry } from "../apps-registry";
import { fileFieldStore } from "../field-store";
import { isAgentBackedPath } from "../api-server";
import type { Tenant } from "../tenant";
import { registeredNeeds } from "../live/native-foundations";
import { messagesRoutes, patchSettings } from "./routes";
import { fileMessagesStore } from "./store";
import { filePushTokens } from "./tokens";
import { DEFAULT_SETTINGS } from "./types";

class Fail extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

describe("messages API", async () => {
  const root = mkdtempSync(join(tmpdir(), "day2-messages-api-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), '{"dependencies":{"expo":"54"}}');
  const app: AppEntry = { id: "app_m", name: "Dotty", repoPath: root, connectionMethod: "local_path", addedAt: "2026-09-01T00:00:00Z" };
  const store = fileMessagesStore(join(root, "m"));
  const tokens = filePushTokens(join(root, "m"));
  const field = fileFieldStore(join(root, "f"));
  await tokens.save(app.id, { user: `u_${"1".repeat(32)}`, token: "ExponentPushToken[abcdefghijkl]", platform: "ios", tz: "Europe/Berlin", tzOffset: null, locale: "de" }, new Date());
  const routes = messagesRoutes({
    requireApp: async (_t, id) => {
      if (id !== app.id) throw new Fail(404, "No app");
      return app;
    },
    fail: (s, m) => new Fail(s, m),
    runWithCredits: async () => {
      throw new Error("no agents in this test");
    },
    actorName: async () => "Pablo",
    stores: () => ({ store, tokens, field }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = new URLPattern({ pathname: r.path }).exec(`http://x${path}`);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.pathname.groups).filter(([, v]) => v !== undefined)) as Record<string, string>;
      try {
        const res = await r.handler(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), params, {} as Tenant);
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      } catch (err) {
        if (err instanceof Fail) return { status: err.status, body: { error: err.message } };
        throw err;
      }
    }
    return { status: 404, body: {} };
  };

  test("the page: reach without tokens, settings, setup state", async () => {
    const r = await call("GET", "/api/apps/app_m/messages");
    expect(r.status).toBe(200);
    expect(r.body.reach).toEqual({ push: 1, ios: 1, android: 0, inAppOnly: 0, identified: 0 });
    expect(r.body.settings).toEqual(DEFAULT_SETTINGS);
    expect(r.body.nativeReady).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("ExponentPushToken");
  });

  test("settings within bounds", async () => {
    expect((await call("PUT", "/api/apps/app_m/messages/settings", { quietHours: { start: 22, end: 8 }, maxPerWeek: 2, autonomy: { announcements: "auto" } })).body.settings).toMatchObject({ quietHours: { start: 22, end: 8 }, maxPerWeek: 2, autonomy: { lifecycle: "auto", announcements: "auto" } });
    expect((await call("PUT", "/api/apps/app_m/messages/settings", { quietHours: { start: 23, end: 2 } })).status).toBe(400);
    expect((await call("PUT", "/api/apps/app_m/messages/settings", { maxPerWeek: 30 })).status).toBe(400);
    expect(() => patchSettings(DEFAULT_SETTINGS, { autonomy: { lifecycle: "maybe" } })).toThrow();
  });

  test("an announcement the owner writes starts at once; bad texts are refused", async () => {
    const bad = await call("POST", "/api/apps/app_m/messages/announcements", { name: "News", texts: { de: { title: "LETZTE CHANCE!!", body: "Nur heute" } } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain("urgency");
    const r = await call("POST", "/api/apps/app_m/messages/announcements", { name: "Neue Galerie", texts: { de: { title: "Neu: die Galerie", body: "Alle deine Punktebilder an einem Ort." }, en: { title: "New: the gallery", body: "All your dot pictures in one place." } }, route: "/gallery" });
    expect(r.status).toBe(201);
    const c = r.body.campaign as { id: string; status: string; by: string; approvedBy: string; route: string; holdout: number };
    expect(c).toMatchObject({ status: "active", by: "owner", approvedBy: "Pablo", route: "/gallery", holdout: 0.1 });
    // Pause, resume, stop.
    expect(((await call("POST", `/api/apps/app_m/messages/campaigns/${c.id}/pause`)).body.campaigns as Array<{ status: string }>)[0]!.status).toBe("paused");
    expect((await call("POST", `/api/apps/app_m/messages/campaigns/${c.id}/pause`)).status).toBe(409);
    expect(((await call("POST", `/api/apps/app_m/messages/campaigns/${c.id}/resume`)).body.campaigns as Array<{ status: string }>)[0]!.status).toBe("active");
    expect(((await call("POST", `/api/apps/app_m/messages/campaigns/${c.id}/stop`)).body.campaigns as Array<{ status: string; stoppedReason: string }>)[0]).toMatchObject({ status: "stopped", stoppedReason: "Stopped by Pablo." });
    expect((await call("POST", `/api/apps/app_m/messages/campaigns/nope/approve`)).status).toBe(404);
  });

  test("editing texts re-checks them; an asked-for announcement needs a topic", async () => {
    const st = await store.state(app.id);
    const id = st.campaigns[0]!.id;
    expect((await call("PUT", `/api/apps/app_m/messages/campaigns/${id}/texts`, { texts: { de: { title: "x".repeat(41), body: "y" } } })).status).toBe(400);
    const ok = await call("PUT", `/api/apps/app_m/messages/campaigns/${id}/texts`, { texts: { de: { title: "Neu: die Galerie", body: "Schau dir deine Bilder an." }, en: { title: "New: the gallery", body: "See your pictures." } } });
    expect(ok.status).toBe(200);
    expect((await call("POST", "/api/apps/app_m/messages/announcements", { about: "short" })).status).toBe(400);
    const log = (await store.state(app.id)).log.map((l) => l.text);
    expect(log.some((t) => t.includes("Pablo edited the texts"))).toBe(true);
  });

  test("registers the native need for expo-notifications; the draft call is agent-backed", async () => {
    const need = registeredNeeds().find((n) => n.module === "messages")!;
    expect(need.packages).toContain("expo-notifications");
    expect(await need.whenNeeded(app)).toBe(true);
    expect(isAgentBackedPath("/api/apps/app_m/messages/announcements")).toBe(true);
  });
});
