import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase } from "../db/test-db";
import { dbFieldStore } from "../field-store";
import { dbNumbersStore } from "./store";

/** The Numbers cache and the events' platform in Postgres (migration 018). */

let t: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  t = await createTestDatabase();
  const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
  await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('dotty', ${acc!.id}, 'Dotty', '/tmp/dotty', 'github')`;
});
afterAll(async () => t.drop());

describe("Numbers in Postgres", () => {
  test("the cache: empty by default, updates one at a time, kept across loads", async () => {
    const s = dbNumbersStore(t.sql);
    expect((await s.load("dotty")).settings).toEqual({ appleVendorNumber: null, playBucket: null });
    const today = new Date().toISOString().slice(0, 10);
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        s.update("dotty", (d) => ({ doc: { ...d, apple: { ...d.apple, seenInstances: [...d.apple.seenInstances, `i${i}`] }, series: { ...d.series, "ios.downloads": { ...(d.series["ios.downloads"] ?? {}), [today]: { v: i, p: today } } } }, result: null })),
      ),
    );
    const d = await s.load("dotty");
    expect(d.apple.seenInstances.sort()).toEqual(["i0", "i1", "i2", "i3"]);
    expect(d.series["ios.downloads"]![today]).toEqual({ v: 3, p: today });
    await s.update("dotty", (x) => ({ doc: { ...x, settings: { appleVendorNumber: "85912345", playBucket: "pubsite_prod_rev_1" } }, result: null }));
    expect((await s.load("dotty")).settings.playBucket).toBe("pubsite_prod_rev_1");
  });

  test("events keep the platform the device reported", async () => {
    const f = dbFieldStore(t.sql);
    const now = new Date();
    await f.record("dotty", { v: 1, device: { id: "d1", platform: "android" }, passes: {}, failures: [], events: [{ type: "visit", at: now.toISOString() }] }, now);
    const evs = await f.events("dotty", new Date(now.getTime() - 60_000));
    expect(evs).toEqual([expect.objectContaining({ type: "visit", deviceId: "d1", platform: "android" })]);
  });
});
