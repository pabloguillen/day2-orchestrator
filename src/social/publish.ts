import { readFile } from "node:fs/promises";
import type { AssetStore } from "../ads/assets";
import { redact } from "../ads/http";
import { PlatformError, type PlatformDeps } from "../ads/types";
import { executeChannelAction } from "../growth-execution";
import type { Creative } from "../growth-creative";
import type { BudgetConfig, SpendLedgerEntry } from "../spend-governance";
import { facebookStep, instagramStep, type MetaPublishCtx, type StepResult } from "./meta";
import type { MediaLinkStore, SocialAccount, SocialAccountStore, SocialPostStore } from "./store";
import { tiktokAccessToken, tiktokStep, type TikTokApp } from "./tiktok";
import { contentHash, DAILY_LIMIT, MAX_ATTEMPTS, type Post, type PostStatus, type SocialPlatform, type Target } from "./types";
import { socialArm } from "./make";

/**
 * Publishing approved posts when their time comes (the autopilot timer):
 *
 *  - only posts the owner approved (or that went out on their own with the
 *    autonomy switch on), never while the app's kill switch or Social pause
 *    is on, and only through growth-execution.ts's gates;
 *  - at most DAILY_LIMIT posts per platform per 24 h (and Instagram's own
 *    limit, checked before each post);
 *  - one target at a time is claimed (a 10-minute lease, inside the post's
 *    row lock), and every id a platform returns is saved right away — a
 *    retry continues from it, and a post whose last try ended in the
 *    unknown is looked up before anything is sent again: never posted twice;
 *  - failures back off (5 min, 10, 20…) up to MAX_ATTEMPTS, then the target
 *    is marked failed with the platform's reason;
 *  - the public media link is unguessable and ends 24 h after the post.
 */

export type PublishDeps = {
  posts: SocialPostStore;
  accounts: SocialAccountStore;
  links: MediaLinkStore;
  assets: AssetStore;
  publicUrl: string;
  meta: { appSecret?: string; apiVersion: string } | null;
  tiktok: TikTokApp | null;
  platformDeps?: PlatformDeps;
  now?: () => Date;
  /** Kill switch on, or Social paused: nothing goes out. */
  stopped: boolean;
  budget: BudgetConfig;
  ledger: SpendLedgerEntry[];
  log?: (text: string) => void;
  /** After each published target (growth feed). */
  onPublished?: (post: Post, target: Target) => void;
  /** Steps run back to back before the target waits for the next pass. */
  maxSteps?: number;
};

export type PublishReport = { published: string[]; failed: string[]; waiting: number; deferred: string[] };

const LEASE_MS = 10 * 60_000;
const PLATFORM_NAME: Record<SocialPlatform, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok" };
export const backoffMs = (attempts: number) => Math.min(6 * 3_600_000, 5 * 60_000 * 2 ** Math.max(0, attempts - 1));

/** A post's status from its targets. Pure. */
export function postStatusOf(p: Post): PostStatus {
  if (p.status === "declined" || p.status === "draft" || p.status === "waiting_approval") return p.status;
  const live = p.targets.filter((t) => t.status !== "skipped");
  if (!live.length) return "failed";
  if (live.every((t) => t.status === "published")) return "published";
  if (live.every((t) => t.status === "published" || t.status === "failed")) return live.some((t) => t.status === "published") ? "published" : "failed";
  if (live.some((t) => t.status === "publishing" || t.status === "published" || t.attempts > 0)) return "publishing";
  return "approved";
}

const ext = (mime: string) => (mime === "video/mp4" ? ".mp4" : mime === "image/png" ? ".png" : ".jpg");

/** Posts published per platform in the 24 h before `now` (targets), from the app's posts. Pure. */
export function postedLastDay(posts: Post[], now: Date): Record<SocialPlatform, number> {
  const out: Record<SocialPlatform, number> = { instagram: 0, facebook: 0, tiktok: 0 };
  for (const p of posts) for (const t of p.targets) if ((t.status === "published" && t.publishedAt && now.getTime() - Date.parse(t.publishedAt) < 86_400_000) || t.status === "publishing") out[t.platform]++;
  return out;
}

export async function publishDue(appId: string, d: PublishDeps): Promise<PublishReport> {
  const report: PublishReport = { published: [], failed: [], waiting: 0, deferred: [] };
  const now = () => (d.now ? d.now() : new Date());
  if (d.stopped) return report;
  const all = await d.posts.due(appId);
  const accounts = new Map((await d.accounts.forApp(appId)).map((a) => [a.network, a] as const));
  const counts = postedLastDay(all, now());
  for (const post of all) {
    if (post.status !== "approved" && post.status !== "publishing") continue;
    if (!post.scheduledAt || Date.parse(post.scheduledAt) > now().getTime()) continue;
    for (let i = 0; i < post.targets.length; i++) {
      const t = post.targets[i]!;
      if (t.status !== "pending" && t.status !== "publishing") continue;
      if (t.nextAttemptAt && Date.parse(t.nextAttemptAt) > now().getTime()) {
        report.waiting++;
        continue;
      }
      const label = `${post.id} on ${PLATFORM_NAME[t.platform]}`;
      if (t.status === "pending" && counts[t.platform] >= DAILY_LIMIT[t.platform]) {
        await d.posts.update(appId, post.id, (p) => {
          p.targets[i]!.nextAttemptAt = new Date(now().getTime() + 3_600_000).toISOString();
          p.targets[i]!.note = `Waiting: day2 posts at most ${DAILY_LIMIT[t.platform]} times a day on ${PLATFORM_NAME[t.platform]}.`;
          return p;
        });
        report.deferred.push(label);
        continue;
      }
      const account = accounts.get(t.platform === "tiktok" ? "tiktok" : "meta");
      const outcome = await publishTarget(appId, post.id, i, account ?? null, d, now);
      if (outcome === "published") {
        report.published.push(label);
        if (t.status === "pending") counts[t.platform]++;
      } else if (outcome === "failed") report.failed.push(label);
      else if (outcome === "deferred") report.deferred.push(label);
      else if (outcome === "waiting") report.waiting++;
    }
  }
  return report;
}

type Outcome = "published" | "failed" | "waiting" | "deferred" | "skipped";

/** Claims one target, runs its steps, saves every result. */
export async function publishTarget(appId: string, postId: string, index: number, account: SocialAccount | null, d: PublishDeps, now: () => Date): Promise<Outcome> {
  // Claim: only if nobody else holds it, and it's still due.
  const claim = { got: false, resuming: false, changed: false };
  const claimed = await d.posts.update(appId, postId, (p) => {
    const t = p.targets[index];
    if (!t || (t.status !== "pending" && t.status !== "publishing")) return null;
    if (p.status !== "approved" && p.status !== "publishing") return null;
    // Only what the owner (or the autonomy switch) approved goes out: changed since → back to the owner.
    if (!p.approvedHash || p.approvedHash !== contentHash(p)) {
      if (p.targets.every((x) => x.status === "pending")) {
        p.status = "waiting_approval";
        p.approvedBy = null;
        p.approvedAt = null;
        p.approvedHash = null;
        claim.changed = true;
        return p;
      }
      return null;
    }
    const lease = t.leaseUntil;
    if (lease && Date.parse(lease) > now().getTime()) return null;
    claim.resuming = t.status === "publishing" && !t.stepId;
    claim.got = true;
    t.status = "publishing";
    t.claimedAt ??= now().toISOString();
    t.leaseUntil = new Date(now().getTime() + LEASE_MS).toISOString();
    p.status = "publishing";
    return p;
  });
  const post = claimed;
  const t0 = post?.targets[index];
  if (!claim.got || !post || !t0) return "skipped";
  const resuming = claim.resuming;

  const save = (fn: (t: Target, p: Post) => void, release = false) =>
    d.posts.update(appId, postId, (p) => {
      const t = p.targets[index]!;
      fn(t, p);
      if (release) t.leaseUntil = null;
      p.status = postStatusOf(p);
      return p;
    });

  const fail = async (why: string, retryable: boolean): Promise<Outcome> => {
    let final = false;
    await save((t) => {
      t.attempts++;
      t.error = redact(why).slice(0, 400);
      if (!retryable || t.attempts >= MAX_ATTEMPTS) {
        t.status = "failed";
        final = true;
      } else {
        t.nextAttemptAt = new Date(now().getTime() + backoffMs(t.attempts)).toISOString();
      }
    }, true);
    d.log?.(`${PLATFORM_NAME[t0.platform]}: ${final ? "couldn't post" : "will try again"} (${redact(why).slice(0, 160)}).`);
    return final ? "failed" : "waiting";
  };

  if (!account) return fail(`${PLATFORM_NAME[t0.platform]} isn't connected any more`, false);
  if (t0.platform === "tiktok" && !d.tiktok) return fail("TikTok posting isn't set up on this server (TIKTOK_CONTENT_CLIENT_KEY)", true);
  if (t0.platform !== "tiktok" && !d.meta) return fail("Meta isn't set up on this server (META_APP_ID)", true);
  const asset = await d.assets.get(t0.assetId);
  const file = asset ? await d.assets.file(asset.id) : null;
  if (!asset || !file) return fail("the post's media is missing", false);

  // The public link platforms fetch from: new for every fresh start, ends 24 h after the post (48 h until then).
  const mediaUrl = async (assetId: string, mime: string) => {
    const l = await d.links.create(appId, assetId, new Date(now().getTime() + 48 * 3_600_000));
    return `${d.publicUrl.replace(/\/+$/, "")}/api/assets/${l.token}${ext(mime)}`;
  };

  const runSteps = async (): Promise<{ outcome: Outcome; ref: string }> => {
    let t = t0;
    const max = d.maxSteps ?? 8;
    const sleep = d.platformDeps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let urls: { media: string; cover?: string | null } | null = null;
    for (let step = 0; step < max; step++) {
      let r: StepResult;
      if (t.platform === "tiktok") {
        if (account.network !== "tiktok") throw new PlatformError("tiktok", "wrong account");
        const token = await tiktokAccessToken(appId, d.accounts, d.tiktok!, d.platformDeps ?? {});
        r = await tiktokStep(d.tiktok!, token, t, {
          bytes: async () => new Uint8Array(await readFile(file)),
          durationSec: asset.durationSec ?? 0,
          choices: post.tiktok!,
          onStepId: async (id) => {
            await save((x) => (x.stepId = id));
          },
        }, d.platformDeps);
      } else {
        if (account.network !== "meta") throw new PlatformError("meta", "wrong account");
        const ctx: MetaPublishCtx = { pageId: account.meta.pageId, pageToken: account.tokens.pageToken, igUserId: account.meta.igUserId, appSecret: d.meta!.appSecret, apiVersion: d.meta!.apiVersion, deps: d.platformDeps ?? {} };
        const needsUrl = !t.stepId || t.stepId.endsWith(":started");
        if (needsUrl && !urls) {
          const cover = t.coverAssetId && asset.kind === "video" ? await d.assets.get(t.coverAssetId) : null;
          urls = { media: await mediaUrl(asset.id, asset.mime), cover: cover ? await mediaUrl(cover.id, cover.mime) : null };
        }
        r = t.platform === "instagram" ? await instagramStep(ctx, t, urls ?? { media: "" }, asset.kind) : await facebookStep(ctx, t, urls ?? { media: "" }, { resuming: resuming && step === 0 });
      }
      if (r.kind === "published") {
        const at = now();
        await save((x) => {
          x.status = "published";
          x.externalId = r.externalId;
          x.permalink = r.permalink;
          x.publishedAt = at.toISOString();
          x.note = r.note ?? null;
          x.error = null;
          x.nextAttemptAt = null;
        }, true);
        await d.links.expireAsset(appId, asset.id, new Date(at.getTime() + 24 * 3_600_000)).catch(() => {});
        if (t.coverAssetId) await d.links.expireAsset(appId, t.coverAssetId, new Date(at.getTime() + 24 * 3_600_000)).catch(() => {});
        return { outcome: "published", ref: r.externalId };
      }
      if (r.kind === "restart") {
        const out = await fail(r.reason, true);
        await save((x) => (x.stepId = null));
        return { outcome: out, ref: "" };
      }
      if (r.kind === "deferred") {
        await save((x) => {
          x.nextAttemptAt = new Date(now().getTime() + r.untilMs).toISOString();
          x.note = `Waiting: ${r.reason}.`;
        }, true);
        return { outcome: "deferred", ref: "" };
      }
      // waiting: keep the id; continue now, or on the next pass when it takes a while.
      const updated = await save((x) => (x.stepId = r.stepId));
      t = updated?.targets[index] ?? { ...t, stepId: r.stepId };
      if (r.retryInMs > 45_000 || step === max - 1) {
        await save((x) => (x.nextAttemptAt = new Date(now().getTime() + Math.max(r.retryInMs, 30_000)).toISOString()), true);
        return { outcome: "waiting", ref: "" };
      }
      if (r.retryInMs > 0) await sleep(r.retryInMs);
    }
    return { outcome: "waiting", ref: "" };
  };

  try {
    if (t0.stepId || resuming || t0.attempts > 0) return (await runSteps()).outcome;
    // A fresh post goes through the growth execution gates once (claims, kill switch, budget).
    let outcome: Outcome = "waiting";
    let thrown: unknown = null;
    const creative: Creative = { arm: socialArm(post.source.arm), segment: "", headline: post.idea.title, body: t0.caption, claimsCheckedAgainst: [], costUsd: 0 };
    const r = await executeChannelAction({
      creative,
      claimsCheck: { creative, truthful: post.safety.ok, issues: post.safety.issues },
      authenticityCheck: { creative, readsAsGeneric: false, matchedPatterns: [], suggestion: "" },
      spendRequest: { id: `social:${post.id}:${t0.format}`, category: "social_content", amountUsd: 0, description: `Organic ${t0.format} post`, requestedAt: now().toISOString() },
      budget: d.budget,
      ledger: d.ledger,
      consecutiveGenericFlags: 0,
      allowLiveAction: true,
      liveAction: async () => {
        try {
          const x = await runSteps();
          outcome = x.outcome;
          return { externalRef: x.ref || `pending:${post.id}` };
        } catch (err) {
          thrown = err;
          throw err;
        }
      },
    });
    if (r.status === "executed") return outcome;
    if (r.status === "execution_failed") throw thrown ?? new Error(r.reason);
    const why = r.status === "blocked_by_claims_check" ? "the safety check didn't pass" : r.status === "blocked_by_budget" && !r.spendDecision.allowed ? r.spendDecision.reason : r.status.replace(/_/g, " ");
    return fail(why, r.status === "blocked_by_budget");
  } catch (err) {
    const retryable = err instanceof PlatformError ? err.retryable || (err.status ?? 0) >= 500 : true;
    return fail((err as Error).message, retryable);
  }
}
