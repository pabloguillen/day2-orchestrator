import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDatabase } from "../db/test-db";
import { dbStoreListing } from "./store";
import type { StoreReview } from "./types";

let t: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  t = await createTestDatabase();
  const [acc] = (await t.sql`INSERT INTO accounts (name) VALUES ('A') RETURNING id`) as Array<{ id: string }>;
  await t.sql`INSERT INTO apps (id, account_id, name, repo_path, connection_method) VALUES ('dotty', ${acc!.id}, 'Dotty', '/tmp/dotty', 'github')`;
});
afterAll(async () => t.drop());

const review = (id: string, createdAt: string, o: Partial<StoreReview> = {}): StoreReview => ({ store: "ios", id, rating: 4, title: "", body: "Gut", author: "a", territory: null, language: null, version: null, createdAt, existingReply: null, reply: null, problemKey: null, ticketId: null, triaged: false, ...o });

describe("Store module in Postgres", () => {
  test("the document: defaults when empty, updates one at a time, kept across loads", async () => {
    const s = dbStoreListing(t.sql);
    expect((await s.load("dotty")).settings.autonomy.listing).toBe("ask");
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        s.update("dotty", (f) => {
          f.log.push({ at: String(i), text: `step ${i}` });
          f.settings.locales = ["de-DE", "en-US"];
          return { file: f, result: null };
        }),
      ),
    );
    const f = await s.load("dotty");
    expect(f.log).toHaveLength(4);
    expect(f.settings.locales).toEqual(["de-DE", "en-US"]);
  });

  test("reviews upsert by store and id, newest first; a year is kept", async () => {
    const s = dbStoreListing(t.sql);
    await s.saveReviews("dotty", [review("r1", "2026-10-01T00:00:00Z"), review("r2", "2026-11-01T00:00:00Z"), review("old", "2024-01-01T00:00:00Z")]);
    await s.saveReviews("dotty", [review("r1", "2026-10-01T00:00:00Z", { reply: { text: "Danke", state: "sent", by: "day2", at: "x", sentAt: "x", error: null } })]);
    const rs = await s.reviews("dotty");
    expect(rs.map((r) => [r.id, r.reply?.state ?? null])).toEqual([
      ["r2", null],
      ["r1", "sent"],
    ]);
  });
});
