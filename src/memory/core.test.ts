import { describe, expect, test } from "bun:test";
import { buildCapturePrompt, captureDue, finishCapture, nextBatch, parseCapture, wordDiff } from "./capture";
import {
  addItem,
  applyDistilled,
  blockedTargets,
  editItem,
  isBlocked,
  kindBlocked,
  MemoryError,
  MEMORY_BLOCK_CHARS,
  mirrorRules,
  proposalKey,
  recordDecline,
  recordInput,
  renderMemoryBlock,
  selectForPurpose,
  setStatus,
} from "./core";
import { scrub, unsafeReason } from "./privacy";
import { emptyMemory, type MemoryDoc } from "./types";

const now = new Date("2026-11-01T10:00:00Z");
const day = 86_400_000;
const owner = { kind: "owner_comment" as const, ref: { type: "ticket" as const, id: "D2-1" } };

describe("privacy filter", () => {
  test("refuses secrets and personal data", () => {
    for (const bad of [
      "Our key is sk-ant-api03-abcdefghijklmnopqrstuvwx",
      "use ghp_abcdefghijklmnopqrstuvwxyz0123",
      "password: hunter2",
      "Email jane.doe@example.com when it breaks",
      "Call +49 170 1234567",
      "Card 4111 1111 1111 1111",
      "user u_9f8e7d6c5b4a broke it",
      "device 123e4567-e89b-12d3-a456-426614174000",
      "The user named Peter complained",
      "https://api.example.com/x?token=abc123",
    ]) {
      expect(unsafeReason(bad)).not.toBeNull();
    }
  });
  test("lets plain guidance through, including dates, versions and prices", () => {
    for (const ok of ["Keep push texts under 60 characters.", "Launch on 2026-12-01.", "We use Expo SDK 54.0.1 and React Native 0.81.", "Pro costs 4.99 a month.", "Never show ads to kids."]) {
      expect(unsafeReason(ok)).toBeNull();
    }
  });
  test("scrub redacts before an agent reads it", () => {
    const s = scrub("Ping me at a@b.co, token=ghp_abcdefghijklmnopqrstuvwxyz0123 thanks");
    expect(s).not.toContain("a@b.co");
    expect(s).not.toContain("ghp_");
    expect(s).toContain("thanks");
  });
});

describe("items", () => {
  test("add, dedupe, edit, confirm, retire", () => {
    let d = emptyMemory();
    const a = addItem(d, { kind: "preference", text: "Keep texts short.", source: owner, who: "Pablo" }, now);
    d = a.doc;
    expect(a.item.status).toBe("active");
    const again = addItem(d, { kind: "preference", text: "keep texts short", source: owner, who: "Pablo" }, now);
    expect(again.duplicate).toBe(true);
    expect(again.doc.items).toHaveLength(1);
    const e = editItem(d, a.item.id, { text: "Keep texts under 60 characters." }, "Pablo", now);
    expect(e.item.source.kind).toBe("correction");
    expect(e.item.confidence).toBe(1);
    const r = setStatus(e.doc, a.item.id, "retired", now);
    expect(r.item.status).toBe("retired");
  });
  test("refuses unsafe text with a plain reason", () => {
    expect(() => addItem(emptyMemory(), { kind: "fact", text: "Admin login is admin@x.io", source: owner, who: "x" }, now)).toThrow(MemoryError);
  });
  test("newer supersedes older and the owner sees the change", () => {
    const a = addItem(emptyMemory(), { kind: "preference", text: "Use a playful tone.", source: owner, who: "x" }, now);
    const b = addItem(a.doc, { kind: "preference", text: "Use a calm, serious tone.", source: owner, who: "x", supersedes: a.item.id }, new Date(now.getTime() + 1000));
    const old = b.doc.items.find((i) => i.id === a.item.id)!;
    expect(old.status).toBe("retired");
    expect(old.supersededBy).toBe(b.item.id);
    expect(b.item.supersedes).toBe(a.item.id);
    expect(b.doc.changes[0]!.text).toContain("is now");
  });
  test("custom backlog rules mirror as active rule items and follow edits", () => {
    let d = mirrorRules(emptyMemory(), [{ id: "r-x", kind: "custom", text: "Never touch the login screen.", enabled: true }, { id: "r-bugs", kind: "builtin", text: "builtin", enabled: true }], "Pablo", now);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ kind: "rule", status: "active", ruleId: "r-x", source: { kind: "backlog_rule" } });
    d = mirrorRules(d, [{ id: "r-x", kind: "custom", text: "Never touch the sign-in screen.", enabled: true }], "Pablo", now);
    expect(d.items[0]!.text).toBe("Never touch the sign-in screen.");
    d = mirrorRules(d, [], "Pablo", now);
    expect(d.items[0]!.status).toBe("retired");
  });
});

describe("hard filter", () => {
  test("a decline blocks the same kind and target for 90 days", () => {
    const d = recordDecline(emptyMemory(), { kind: "money.product", target: "Lifetime", reason: "No lifetime deals", who: "x", at: now.toISOString(), ref: null });
    expect(isBlocked(d, proposalKey("money.product", "lifetime"), new Date(now.getTime() + 10 * day)).blocked).toBe(true);
    expect(isBlocked(d, proposalKey("money.product", "pro_monthly"), now).blocked).toBe(false);
    expect(isBlocked(d, proposalKey("money.product", "lifetime"), new Date(now.getTime() + 91 * day)).blocked).toBe(false);
    expect(isBlocked(d, proposalKey("money.product", "lifetime"), now, { ownerAsked: true }).blocked).toBe(false);
    expect(blockedTargets(d, "money.product", now)).toEqual(["lifetime"]);
  });
  test("an active do_not blocks while active; an unconfirmed one for 90 days; wildcard blocks the kind", () => {
    let d = addItem(emptyMemory(), { kind: "do_not", text: "No interstitial ads.", source: owner, who: "x", keys: ["money.ad:*"] }, now).doc;
    expect(isBlocked(d, "money.ad:level_end", new Date(now.getTime() + 400 * day)).blocked).toBe(true);
    expect(kindBlocked(d, "money.ad", now).blocked).toBe(true);
    d = addItem(emptyMemory(), { kind: "do_not", text: "Don't test the subtitle.", source: { kind: "decline", ref: null }, who: "x", keys: ["store.text:subtitle"], status: "needs_confirmation" }, now).doc;
    expect(isBlocked(d, "store.text:subtitle", new Date(now.getTime() + 30 * day)).blocked).toBe(true);
    expect(isBlocked(d, "store.text:subtitle", new Date(now.getTime() + 100 * day)).blocked).toBe(false);
  });
});

describe("memoryFor ranking and block", () => {
  function many(): MemoryDoc {
    let d = emptyMemory();
    d = addItem(d, { kind: "tech", text: "The app uses Expo Router and Zustand.", source: owner, who: "x" }, now).doc;
    d = addItem(d, { kind: "audience", text: "Most users are nurses on night shifts.", source: owner, who: "x" }, now).doc;
    d = addItem(d, { kind: "preference", text: "Push texts are friendly, never pushy.", source: owner, who: "x", scope: ["messages"] }, now).doc;
    d = addItem(d, { kind: "do_not", text: "Don't propose a lifetime plan.", source: { kind: "decline", ref: null }, who: "x", status: "needs_confirmation", confidence: 0.5 }, now).doc;
    return d;
  }
  test("ranks by purpose", () => {
    const d = many();
    expect(selectForPurpose(d, "build")[0]!.kind).toBe("tech");
    expect(selectForPurpose(d, "messages")[0]!.text).toContain("Push texts");
    expect(selectForPurpose(d, "store")[0]!.kind).toBe("audience");
  });
  test("caps the block at about 1,500 tokens and marks unconfirmed items", () => {
    let d = emptyMemory();
    for (let i = 0; i < 80; i++) d = addItem(d, { kind: "fact", text: `Fact number ${i} about the app is long enough to take up some room in the block.`, source: owner, who: "x" }, now).doc;
    const block = renderMemoryBlock(selectForPurpose(d, "answer"));
    expect(block.length).toBeLessThanOrEqual(MEMORY_BLOCK_CHARS);
    expect(renderMemoryBlock(selectForPurpose(many(), "money"))).toContain("(not confirmed)");
    expect(renderMemoryBlock([])).toBe("");
  });
});

describe("memory keeper", () => {
  test("a single decline gives needs_confirmation; an owner comment is active; unsafe output is dropped", () => {
    let d = recordInput(emptyMemory(), { kind: "decline", text: "Too pushy for our users", proposal: { kind: "messages.campaign", target: "winback_d3" }, ref: null, who: "Pablo", at: now.toISOString() });
    d = recordInput(d, { kind: "comment", text: "We always write in British English.", ref: { type: "ticket", id: "D2-3" }, who: "Pablo", at: now.toISOString() });
    const [dec, com] = d.inbox;
    const answer = JSON.stringify({
      items: [
        { kind: "do_not", text: "Don't send win-back pushes after 3 days.", scope: ["messages"], keys: [], confidence: 0.6, from: [dec!.id], supersedes: null },
        { kind: "preference", text: "Write in British English.", scope: [], confidence: 0.9, from: [com!.id] },
        { kind: "fact", text: "Support is at help@x.io", from: [com!.id], confidence: 1 },
      ],
    });
    const r = finishCapture(d, answer, nextBatch(d), now);
    expect(r.added).toHaveLength(2);
    expect(r.rejected).toBe(1);
    const dn = r.added.find((i) => i.kind === "do_not")!;
    expect(dn.status).toBe("needs_confirmation");
    expect(dn.keys).toEqual(["messages.campaign:winback_d3"]);
    expect(dn.source.kind).toBe("decline");
    expect(r.added.find((i) => i.kind === "preference")!.status).toBe("active");
    expect(r.doc.inbox).toHaveLength(0);
    expect(r.doc.lastCaptureAt).toBe(now.toISOString());
  });
  test("parse ignores unknown kinds, input ids and supersedes", () => {
    const out = parseCapture('{"items":[{"kind":"wish","text":"x y z"},{"kind":"fact","text":"Real fact here","from":["nope"],"supersedes":"m-zzz"}]}', new Set(["in-1"]), new Set(["m-1"]));
    expect(out).toEqual([{ kind: "fact", text: "Real fact here", scope: [], keys: [], confidence: 0.6, from: [], supersedes: null }]);
  });
  test("the prompt shows edits as before/after and treats input as data", () => {
    const d = recordInput(emptyMemory(), { kind: "edit", text: "edited subtitle", before: "The best habit app ever", after: "A calm habit app", about: "Store subtitle", ref: null, who: "x", at: now.toISOString() });
    const p = buildCapturePrompt("Dotty", [], d.inbox);
    expect(p).toContain("owner changed it to");
    expect(p).toMatch(/<<<OWNER_INPUT_[0-9A-F]{12}_START>>>/);
    expect(wordDiff("The best habit app ever", "A calm habit app")).toContain("added");
  });
  test("runs at most hourly unless forced, and never with an empty inbox", () => {
    const d = recordInput({ ...emptyMemory(), lastCaptureAt: now.toISOString() }, { kind: "comment", text: "x is y", ref: null, who: "x", at: now.toISOString() });
    expect(captureDue(d, new Date(now.getTime() + 30 * 60_000))).toBe(false);
    expect(captureDue(d, new Date(now.getTime() + 30 * 60_000), true)).toBe(true);
    expect(captureDue(d, new Date(now.getTime() + 61 * 60_000))).toBe(true);
    expect(captureDue(emptyMemory(), now, true)).toBe(false);
  });
  test("applyDistilled links the source input", () => {
    const d = recordInput(emptyMemory(), { kind: "answer", text: "Our users are mostly teachers", ref: { type: "page", id: "tell" }, who: "Pablo", at: now.toISOString() });
    const r = applyDistilled(d, [{ kind: "audience", text: "Most users are teachers.", scope: [], keys: [], confidence: 0.9, from: [d.inbox[0]!.id], supersedes: null }], d.inbox, now);
    expect(r.added[0]!.source).toEqual({ kind: "answer", ref: { type: "page", id: "tell" } });
    expect(r.added[0]!.who).toBe("Pablo");
  });
});
