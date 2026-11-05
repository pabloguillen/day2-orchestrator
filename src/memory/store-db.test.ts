import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../db/test-db";
import { addItem, recordDecline, recordInput } from "./core";
import { dbMemoryStore, fileMemoryStore, type MemoryStore } from "./store";

/** App memory in both stores: a file per app (local) and Postgres (migration 022). */

let t: Awaited<ReturnType<typeof createTestDatabase>>;
const now = new Date("2026-11-01T10:00:00Z");

beforeAll(async () => {
  t = await createTestDatabase();
  const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
  await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('dotty', ${acc!.id}, 'Dotty', '/tmp/dotty', 'github')`;
});
afterAll(async () => t.drop());

function contract(name: string, make: () => MemoryStore) {
  describe(name, () => {
    test("empty, then items, inbox, declines and usage round-trip", async () => {
      const s = make();
      expect((await s.load("dotty")).items).toEqual([]);
      const id = await s.update("dotty", (d) => {
        const r = addItem(d, { kind: "preference", text: "Keep it short.", source: { kind: "owner_comment", ref: { type: "ticket", id: "D2-1", url: "/apps/dotty/backlog/D2-1" } }, who: "Pablo", scope: ["messages"], keys: [] }, now);
        let doc = recordInput(r.doc, { kind: "comment", text: "hello there", ref: null, who: "Pablo", at: now.toISOString() });
        doc = recordDecline(doc, { kind: "store.text", target: "subtitle", reason: "too salesy", who: "Pablo", at: now.toISOString(), ref: null });
        return { doc: { ...doc, lastCaptureAt: now.toISOString() }, result: r.item.id };
      });
      await s.markUsed("dotty", [id], "messages", now);
      const d = await s.load("dotty");
      expect(d.items).toHaveLength(1);
      expect(d.items[0]).toMatchObject({ id, kind: "preference", text: "Keep it short.", scope: ["messages"], who: "Pablo", status: "active", lastUsedFor: "messages", lastUsedAt: now.toISOString(), source: { kind: "owner_comment", ref: { type: "ticket", id: "D2-1" } } });
      expect(d.inbox).toHaveLength(1);
      expect(d.declines[0]).toMatchObject({ key: "store.text:subtitle", reason: "too salesy" });
      expect(d.lastCaptureAt).toBe(now.toISOString());
    });
    test("updates one at a time and removes deleted items", async () => {
      const s = make();
      await Promise.all(Array.from({ length: 5 }, (_, i) => s.update("dotty", (d) => ({ doc: addItem(d, { kind: "fact", text: `Fact ${i} here`, source: { kind: "day2_observed", ref: null }, who: "day2" }, now).doc, result: null }))));
      expect((await s.load("dotty")).items.filter((i) => i.kind === "fact")).toHaveLength(5);
      await s.update("dotty", (d) => ({ doc: { ...d, items: d.items.filter((i) => i.kind !== "fact") }, result: null }));
      expect((await s.load("dotty")).items.filter((i) => i.kind === "fact")).toHaveLength(0);
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "day2-mem-"));
contract("file store", () => fileMemoryStore(async () => join(dir, "day2-memory.json")));
contract("Postgres store", () => dbMemoryStore(t.sql));
