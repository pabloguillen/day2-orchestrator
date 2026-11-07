import { selectArm, selectArmWeighted, type AllocatorState, type Arm, armKey } from "../growth-allocator";
import { DAY2_DEFAULT_ON, nativeRatio } from "./catalog";
import type { OwnKey, ToolSetting } from "./store";
import type { AccountKind, Capability, CreativeJob, ToolCreds, ToolDef, ToolId } from "./types";

/**
 * Which creator tool makes something (pure):
 *
 *  1. Eligible: the tool can make it (capability, format, a first frame if
 *     it needs one), Posts/Ads may use it for this app, it has an account to
 *     run on — the owner's own key, or day2's — and on day2's account the
 *     estimate fits what's left of its monthly cap in credits.
 *  2. Best: the growth allocator's results for this kind of post/ad made
 *     with each tool (arm `<format>@<tool>`, Thompson sampling), so day2
 *     learns which tool works for which format. Before any results: the
 *     owner's own account first (already paid for), then the cheapest.
 */

export type Purpose = "posts" | "ads";

export type ToolState = {
  def: ToolDef;
  setting: ToolSetting;
  /** The app's own key wins over the workspace's. */
  own: OwnKey | null;
  operator: ToolCreds | null;
  /** Credits used on day2's account this month. */
  usedCredits: number;
};

export type Candidate = {
  id: ToolId;
  name: string;
  account: AccountKind;
  creds: ToolCreds;
  def: ToolDef;
  /** What this job costs on the account that runs it. */
  estimateUsd: number;
  /** Credits the customer pays for it (0 on their own account). */
  estimateCredits: number;
};

/** The account a tool runs on for this app, or null. Pure. */
export function accountInUse(t: Pick<ToolState, "def" | "setting" | "own" | "operator">): { kind: AccountKind; creds: ToolCreds } | null {
  const own = t.own ? { kind: "own" as const, creds: t.own.creds } : null;
  const day2 = t.operator ? { kind: "day2" as const, creds: t.operator } : null;
  switch (t.setting.account) {
    case "off":
      return null;
    case "own":
      return own;
    case "day2":
      return day2;
    default:
      return own ?? (DAY2_DEFAULT_ON.includes(t.def.id) ? day2 : null);
  }
}

export function candidates(states: ToolState[], purpose: Purpose, job: CreativeJob, creditsFor: (usd: number) => number): Candidate[] {
  const out: Candidate[] = [];
  for (const t of states) {
    if (!t.def.capabilities.includes(job.capability)) continue;
    if (!(purpose === "posts" ? t.setting.posts : t.setting.ads)) continue;
    if (t.def.needsImage?.includes(job.capability) && !("imageUrl" in job && job.imageUrl)) continue;
    if ("ratio" in job && !nativeRatio(t.def, job.capability, job.ratio)) continue;
    const acct = accountInUse(t);
    if (!acct) continue;
    let estimateUsd = 0;
    try {
      estimateUsd = t.def.client(acct.creds).estimateUsd(job);
    } catch {
      continue;
    }
    const estimateCredits = acct.kind === "day2" ? creditsFor(estimateUsd) : 0;
    if (acct.kind === "day2" && t.usedCredits + estimateCredits > t.setting.capCredits) continue;
    out.push({ id: t.def.id, name: t.def.name, account: acct.kind, creds: acct.creds, def: t.def, estimateUsd, estimateCredits });
  }
  return out;
}

/** The allocator arm for "this kind of post/ad, made with this tool". */
export const toolArm = (base: Arm, tool: ToolId): Arm => ({ ...base, formatTag: `${base.formatTag}@${tool}` });

export function pickTool(cands: Candidate[], ctx: { allocator?: AllocatorState; arm?: Arm; rng?: () => number } = {}): Candidate | null {
  if (!cands.length) return null;
  if (ctx.allocator && ctx.arm) {
    const arms = cands.map((c) => toolArm(ctx.arm!, c.id));
    const keys = new Set(arms.map(armKey));
    const seen = ctx.allocator.arms.filter((s) => keys.has(armKey(s.arm)) && s.attempts > 0);
    if (seen.length) {
      // Posts record a continuous reward (engagement), ads record successes (people who reached the outcome).
      const weighted = seen.some((s) => typeof s.totalWeightedReward === "number");
      const best = (weighted ? selectArmWeighted : selectArm)(ctx.allocator, arms, ctx.rng ?? Math.random);
      const id = best.formatTag.slice(best.formatTag.lastIndexOf("@") + 1);
      const hit = cands.find((c) => c.id === id);
      if (hit) return hit;
    }
  }
  return [...cands].sort((a, b) => (a.account === b.account ? 0 : a.account === "own" ? -1 : 1) || a.estimateCredits - b.estimateCredits || a.estimateUsd - b.estimateUsd)[0]!;
}

export type { Capability };
