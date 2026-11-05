import { describe, expect, test } from "bun:test";
import { buildPrompt, buildVerifierPrompt, fixPrompt, verifierPrompt } from "../agent";
import { emptyBacklog } from "../backlog";
import { buildTellPrompt } from "../backlog-tell";
import { buildChangePrompt } from "../change-questions";
import { ideaPrompt, type IdeaInput } from "../live/ideas";
import { buildDraftPrompt } from "../messages/texts";
import { buildStrategyPrompt, type StrategyInput } from "../money/strategy";
import type { AppProfile } from "../onboarding";
import { buildResearchPrompt } from "../retention";
import { buildWritePrompt } from "../store-listing/research";
import { addItem, renderMemoryBlock, selectForPurpose } from "./core";
import { emptyMemory } from "./types";
import type { BugReport } from "../types";

/** Every prompt that works on an app carries the memory block when there is one (and nothing when there isn't). */

const now = new Date("2026-11-01T00:00:00Z");
const doc = addItem(emptyMemory(), { kind: "preference", text: "Keep every text calm and short.", source: { kind: "owner_comment", ref: null }, who: "Pablo" }, now).doc;
const MEMORY = renderMemoryBlock(selectForPurpose(doc, "build"));
const MARK = "## What day2 knows about this app";
const profile = { purpose: "Draw dot art", targetUsers: "Young people", featureMap: ["Canvas"], businessModel: null, toneOfVoice: null, brand: null } as unknown as AppProfile;

const report = (memory?: string): BugReport => ({ title: "Add dark mode", description: "d", sourceId: "s", source: "manual", kind: "build", ...(memory ? { memory } : {}) });

describe("memory block in prompts", () => {
  test("the block itself", () => {
    expect(MEMORY).toContain(MARK);
    expect(MEMORY).toContain("Keep every text calm and short.");
  });

  test("build agent, its verifier, the bug agent and its verifier", () => {
    for (const f of [buildPrompt, buildVerifierPrompt, fixPrompt, verifierPrompt]) {
      expect(f(report(MEMORY))).toContain(MARK);
      expect(f(report())).not.toContain(MARK);
    }
  });

  test("answers to questions and Tell", () => {
    expect(buildChangePrompt("Why red?", { ticket: null, pr: null, memory: MEMORY })).toContain(MARK);
    expect(buildChangePrompt("Why red?", { ticket: null, pr: null })).not.toContain(MARK);
    expect(buildTellPrompt({ instruction: "Do X first", backlog: emptyBacklog(), appName: "Dotty", appContext: `profile\n\n${MEMORY}` })).toContain(MARK);
  });

  test("Live ideas, with the declined settings and what worked elsewhere", () => {
    const input: IdeaInput = { appName: "Dotty", profile: null, code: { files: [], liveKeys: [], excerpts: [] }, values: {}, numbers: { users: 0, events: [], revenuePerUser: null, currency: null }, leak: null, tried: [], memory: MEMORY, avoid: ["live.idea:paywall.trial_days"], worked: ["Free trial length: worked in 7 of 9 similar apps"] };
    const p = ideaPrompt(input);
    expect(p).toContain(MARK);
    expect(p).toContain("don't propose them again: paywall.trial_days");
    expect(p).toContain("worked in 7 of 9 similar apps");
  });

  test("Money strategy", () => {
    const i: StrategyInput = { appName: "Dotty", purpose: "p", targetUsers: "t", featureMap: "f", businessModel: null, brandBrief: "", users: 100, rhythm: null, d7: null, currency: "EUR", baseRegion: "DE", existing: [], minorsHint: false, excerpts: [], memory: MEMORY, avoid: ["money.product:lifetime"] };
    const p = buildStrategyPrompt(i);
    expect(p).toContain(MARK);
    expect(p).toContain("money.product:lifetime");
  });

  test("Store listing texts", () => {
    const p = buildWritePrompt({ appName: "Dotty", profile, listings: { ios: null, android: null } as never, locales: ["en-US"], stores: ["ios"], keywords: [], competitors: [], memory: MEMORY, avoid: ["store.text:subtitle:en-us"] });
    expect(p).toContain(MARK);
    expect(p).toContain("subtitle:en-us");
  });

  test("Messages texts", () => {
    const p = buildDraftPrompt({ appName: "Dotty", purpose: "p", targetUsers: "t", features: [], toneOfVoice: null, brand: null, locales: ["en"], goal: "g", memory: MEMORY });
    expect(p).toContain(MARK);
  });

  test("Retention research", () => {
    const p = buildResearchPrompt({ appName: "Dotty", purpose: "p", targetUsers: "t", featureMap: "f", usageRhythm: null, excerpts: [], senders: [], memory: MEMORY, avoid: ["retention.treatment:at_risk:push"] });
    expect(p).toContain(MARK);
    expect(p).toContain("at_risk:push");
  });
});
