import { request } from "../ads/http";
import { PlatformError, type PlatformDeps } from "../ads/types";
import type { StepResult } from "./meta";
import type { SocialAccountStore, TikTokSocialTokens } from "./store";
import type { Metrics, Target, TikTokChoices } from "./types";

/**
 * TikTok's Content Posting API (developers.tiktok.com) — a separate product
 * from the Marketing API day2's ads use, with its own app (Login Kit +
 * Content Posting API): TIKTOK_CONTENT_CLIENT_KEY / _SECRET.
 *
 *  - Sign-in: https://www.tiktok.com/v2/auth/authorize/ (scopes
 *    user.info.basic, video.publish, video.upload, video.list) →
 *    POST /v2/oauth/token/ (access token 24 h, refresh token 365 days).
 *  - Before every post: POST /v2/post/publish/creator_info/query/ (who
 *    posts, their privacy options, whether comments/duets/stitches are
 *    off, the longest video they may post).
 *  - Direct Post, FILE_UPLOAD: POST /v2/post/publish/video/init/ with the
 *    chunk plan → publish_id + upload_url; PUT each chunk (Content-Range);
 *    POST /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE. FILE_UPLOAD
 *    needs no domain verification (PULL_FROM_URL and photo posts do).
 *  - Results: POST /v2/video/query/ (video.list) for public posts.
 *
 * Until TikTok audits day2's app, every post is private (SELF_ONLY) and at
 * most 5 creators can post in 24 h. Built from TikTok's docs — not yet run
 * against a real account.
 */

export const TIKTOK_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API = "https://open.tiktokapis.com";
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload", "video.list"] as const;
/** Under the already-public /api/ads/connect/callback/<letters> path. */
export const TIKTOK_CALLBACK = "tiktokposts";

export type TikTokApp = { clientKey: string; clientSecret: string; base?: string };

export function tiktokContentApp(env: Record<string, string | undefined> = process.env): TikTokApp | null {
  const clientKey = env.TIKTOK_CONTENT_CLIENT_KEY?.trim();
  const clientSecret = env.TIKTOK_CONTENT_CLIENT_SECRET?.trim();
  if (!clientKey || !clientSecret) return null;
  const base = env.TIKTOK_CONTENT_API_BASE?.trim();
  return { clientKey, clientSecret, ...(base ? { base } : {}) };
}
export const TIKTOK_CONTENT_ENV = ["TIKTOK_CONTENT_CLIENT_KEY", "TIKTOK_CONTENT_CLIENT_SECRET"];

const base = (a: TikTokApp) => (a.base ?? TIKTOK_API).replace(/\/+$/, "");

export function tiktokAuthorizeUrl(a: TikTokApp, o: { state: string; redirectUri: string }): string {
  const u = new URL(TIKTOK_AUTHORIZE);
  u.searchParams.set("client_key", a.clientKey);
  u.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.state);
  return u.toString();
}

type TokenAnswer = { access_token?: string; expires_in?: number; open_id?: string; refresh_token?: string; refresh_expires_in?: number; scope?: string; error?: string; error_description?: string };

async function tokenCall(a: TikTokApp, form: Record<string, string>, deps: PlatformDeps): Promise<{ tokens: TikTokSocialTokens; openId: string; scopes: string[] }> {
  const r = await request<TokenAnswer>("tiktok", deps, `${base(a)}/v2/oauth/token/`, { method: "POST", form: { client_key: a.clientKey, client_secret: a.clientSecret, ...form }, retries: 1 });
  if (!r?.access_token || !r.refresh_token) throw new PlatformError("tiktok", `sign-in failed: ${r?.error_description ?? r?.error ?? "no token returned"}`);
  const now = (deps.now ? deps.now() : new Date()).getTime();
  return {
    tokens: { accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: now + (r.expires_in ?? 86_400) * 1000, refreshExpiresAt: r.refresh_expires_in ? now + r.refresh_expires_in * 1000 : null },
    openId: r.open_id ?? "",
    scopes: (r.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export const exchangeTikTokCode = (a: TikTokApp, o: { code: string; redirectUri: string }, deps: PlatformDeps = {}) =>
  tokenCall(a, { code: decodeURIComponent(o.code), grant_type: "authorization_code", redirect_uri: o.redirectUri }, deps);

/** A valid access token: refreshed when it ends within 10 minutes (TikTok may hand back a new refresh token). */
export async function freshTikTokTokens(a: TikTokApp, t: TikTokSocialTokens, deps: PlatformDeps, save: (t: TikTokSocialTokens) => Promise<void>): Promise<TikTokSocialTokens> {
  const now = (deps.now ? deps.now() : new Date()).getTime();
  if (t.expiresAt - 600_000 > now) return t;
  if (t.refreshExpiresAt && t.refreshExpiresAt < now) throw new PlatformError("tiktok", "the TikTok sign-in expired — connect TikTok again");
  const r = await tokenCall(a, { grant_type: "refresh_token", refresh_token: t.refreshToken }, deps);
  await save(r.tokens);
  return r.tokens;
}

const refreshing = new Map<string, Promise<unknown>>();

/**
 * The app's TikTok access token, refreshed when due — one refresh at a time
 * per app (TikTok may rotate the refresh token, so two refreshes from the
 * same old copy would lose one). Always reads the stored tokens inside the
 * lock, so a later step never uses a token another step already replaced.
 */
export function tiktokAccessToken(appId: string, accounts: SocialAccountStore, a: TikTokApp, deps: PlatformDeps = {}): Promise<string> {
  const run = async () => {
    const acc = await accounts.get(appId, "tiktok");
    if (!acc || acc.network !== "tiktok") throw new PlatformError("tiktok", "TikTok isn't connected");
    const t = await freshTikTokTokens(a, acc.tokens, deps, (x) => accounts.updateTokens(appId, "tiktok", x));
    return t.accessToken;
  };
  const prev = refreshing.get(appId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  refreshing.set(appId, next.catch(() => undefined));
  return next;
}

type Envelope<T> = { data?: T; error?: { code?: string; message?: string; log_id?: string } };

async function call<T>(a: TikTokApp, token: string, deps: PlatformDeps, path: string, json: unknown, query?: Record<string, string>, retries = 2): Promise<T> {
  let r: Envelope<T>;
  try {
    r = await request<Envelope<T>>("tiktok", deps, `${base(a)}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" }, json, query, retries });
  } catch (err) {
    if (err instanceof PlatformError) {
      const code = /"code"\s*:\s*"([a-z_]+)"/.exec(err.message)?.[1];
      if (code) throw new TikTokError(code, err.message, err.retryable || code === "rate_limit_exceeded");
    }
    throw err;
  }
  const code = r?.error?.code;
  if (code && code !== "ok") throw new TikTokError(code, r.error?.message ?? code, code === "rate_limit_exceeded" || code === "internal_error");
  return (r?.data ?? {}) as T;
}

export class TikTokError extends PlatformError {
  constructor(
    public code: string,
    message: string,
    retryable = false,
  ) {
    super("tiktok", `${code}: ${message}`, undefined, retryable);
  }
}

export type CreatorInfo = {
  nickname: string;
  username: string | null;
  avatarUrl: string | null;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoSeconds: number;
  /** Only SELF_ONLY offered: TikTok hasn't audited day2's app yet (or the account is private-only). */
  privateOnly: boolean;
};

export async function creatorInfo(a: TikTokApp, token: string, deps: PlatformDeps = {}): Promise<CreatorInfo> {
  const d = await call<{ creator_nickname?: string; creator_username?: string; creator_avatar_url?: string; privacy_level_options?: string[]; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; max_video_post_duration_sec?: number }>(a, token, deps, "/v2/post/publish/creator_info/query/", {});
  const privacyOptions = d.privacy_level_options ?? [];
  return {
    nickname: d.creator_nickname ?? "",
    username: d.creator_username ?? null,
    avatarUrl: d.creator_avatar_url ?? null,
    privacyOptions,
    commentDisabled: Boolean(d.comment_disabled),
    duetDisabled: Boolean(d.duet_disabled),
    stitchDisabled: Boolean(d.stitch_disabled),
    maxVideoSeconds: d.max_video_post_duration_sec ?? 60,
    privateOnly: privacyOptions.length > 0 && privacyOptions.every((p) => p === "SELF_ONLY"),
  };
}

const MB = 1024 * 1024;

/** The video bytes only ever go to TikTok: https on a *.tiktokapis.com host. Pure. */
export function isTikTokUploadUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "tiktokapis.com" || url.hostname.endsWith(".tiktokapis.com")) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * TikTok's chunk rules (media transfer guide): files under 5 MB go whole;
 * otherwise chunks of 5–64 MB (day2 uses 10 MB), count = floor(size /
 * chunk), and the last chunk takes the remainder (up to 128 MB). Pure.
 */
export function chunkPlan(size: number, chunk = 10 * MB): { chunkSize: number; count: number; ranges: Array<{ start: number; end: number }> } {
  if (size <= 0) throw new Error("empty video");
  const chunkSize = Math.min(64 * MB, Math.max(5 * MB, chunk));
  // Under 5 MB it must go whole; up to one chunk's size it may.
  if (size < 5 * MB || size <= chunkSize) return { chunkSize: size, count: 1, ranges: [{ start: 0, end: size - 1 }] };
  const count = Math.max(1, Math.floor(size / chunkSize));
  if (count > 1000) throw new Error("video too large for TikTok's 1,000 chunks");
  const ranges = Array.from({ length: count }, (_, i) => ({ start: i * chunkSize, end: i === count - 1 ? size - 1 : (i + 1) * chunkSize - 1 }));
  if (ranges[count - 1]!.end - ranges[count - 1]!.start + 1 > 128 * MB) throw new Error("last chunk over 128 MB");
  return { chunkSize, count, ranges };
}

/** Owner choices → TikTok's post_info, checked against what the creator allows right now. */
export function postInfo(t: Target, choices: TikTokChoices, info: CreatorInfo, opts: { coverMs?: number } = {}): Record<string, unknown> {
  const problem = tiktokChoiceProblem(choices, info);
  if (problem) throw new TikTokError("invalid_choices", problem);
  const title = [t.caption.trim(), t.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")].filter(Boolean).join(" ").slice(0, 2200);
  return {
    title,
    privacy_level: choices.privacyLevel,
    disable_comment: !choices.allowComment || info.commentDisabled,
    disable_duet: !choices.allowDuet || info.duetDisabled,
    disable_stitch: !choices.allowStitch || info.stitchDisabled,
    ...(opts.coverMs !== undefined ? { video_cover_timestamp_ms: opts.coverMs } : {}),
    brand_organic_toggle: choices.disclose && choices.yourBrand,
    brand_content_toggle: choices.disclose && choices.brandedContent,
    is_aigc: choices.isAigc,
  };
}

/** Why these choices can't be posted (TikTok's content sharing guidelines), or null. Pure — the console runs the same rules. */
export function tiktokChoiceProblem(c: TikTokChoices | null | undefined, info: Pick<CreatorInfo, "privacyOptions">): string | null {
  if (!c?.privacyLevel) return "Pick who can see the TikTok post.";
  if (!info.privacyOptions.includes(c.privacyLevel)) return "That visibility isn't available on this TikTok account right now.";
  if (c.disclose && !c.yourBrand && !c.brandedContent) return "Say whether the post promotes your own brand, someone else's, or both.";
  if (c.disclose && c.brandedContent && c.privacyLevel === "SELF_ONLY") return "Branded content can't be private on TikTok.";
  return null;
}

/**
 * One step of a TikTok video target: init + upload in one go (the upload
 * URL lasts an hour), then status checks. `onStepId` saves the publish id
 * before the upload starts, so a crash never leads to a second post.
 */
export async function tiktokStep(
  a: TikTokApp,
  token: string,
  t: Target,
  o: { bytes: () => Promise<Uint8Array>; durationSec: number; choices: TikTokChoices; onStepId: (id: string) => Promise<void> },
  deps: PlatformDeps = {},
): Promise<StepResult> {
  if (!t.stepId) {
    const info = await creatorInfo(a, token, deps);
    if (o.durationSec > info.maxVideoSeconds) throw new TikTokError("duration", `the video is ${o.durationSec}s; this account can post up to ${info.maxVideoSeconds}s`);
    const bytes = await o.bytes();
    const plan = chunkPlan(bytes.byteLength);
    const d = await call<{ publish_id?: string; upload_url?: string }>(a, token, deps, "/v2/post/publish/video/init/", {
      post_info: postInfo(t, o.choices, info, { coverMs: 1000 }),
      source_info: { source: "FILE_UPLOAD", video_size: bytes.byteLength, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
    }, undefined, 1); // once: starting a post never repeats on its own
    if (!d.publish_id || !d.upload_url) throw new TikTokError("no_upload_url", "TikTok returned no upload URL");
    if (!isTikTokUploadUrl(d.upload_url)) throw new TikTokError("bad_upload_url", "TikTok returned an upload address day2 doesn't trust");
    await o.onStepId(d.publish_id);
    const doFetch = deps.fetch ?? fetch;
    for (const r of plan.ranges) {
      const body = bytes.subarray(r.start, r.end + 1);
      const res = await doFetch(d.upload_url, { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(body.byteLength), "content-range": `bytes ${r.start}-${r.end}/${bytes.byteLength}` }, body: body as unknown as BodyInit });
      if (res.status !== 201 && res.status !== 206 && !res.ok) {
        // The upload broke off: no post exists yet, start over with a new publish id.
        return { kind: "restart", reason: `TikTok refused the upload (${res.status})` };
      }
    }
    return { kind: "waiting", stepId: d.publish_id, retryInMs: 15_000 };
  }
  const s = await call<{ status?: string; fail_reason?: string; publicaly_available_post_id?: Array<number | string> }>(a, token, deps, "/v2/post/publish/status/fetch/", { publish_id: t.stepId });
  switch (s.status) {
    case "PUBLISH_COMPLETE": {
      const id = s.publicaly_available_post_id?.[0];
      return id !== undefined
        ? { kind: "published", externalId: String(id), permalink: null }
        : { kind: "published", externalId: t.stepId, permalink: null, note: o.choices.privacyLevel === "SELF_ONLY" ? "Posted as private (only you can see it)." : "Posted; TikTok is still reviewing it before it's public." };
    }
    case "FAILED": {
      const why = s.fail_reason ?? "unknown";
      if (why === "internal" || why === "video_pull_failed") return { kind: "restart", reason: `TikTok: ${why}` };
      if (why === "spam_risk_too_many_posts") return { kind: "deferred", untilMs: 24 * 3_600_000, reason: "TikTok's daily post limit for this account is reached" };
      throw new TikTokError(why, `TikTok didn't post it (${why})`);
    }
    case "SEND_TO_USER_INBOX":
      return { kind: "published", externalId: t.stepId, permalink: null, note: "Sent to the TikTok inbox: finish it in the TikTok app." };
    default:
      // Processing takes a while: check again on the next pass.
      return { kind: "waiting", stepId: t.stepId, retryInMs: 60_000 };
  }
}

/**
 * One step of a TikTok photo post (photo mode, Content Posting API
 * /v2/post/publish/content/init/): TikTok pulls the slides from day2's
 * public media links (PULL_FROM_URL — the domain must be verified for the
 * TikTok app; gora8.com is), then status checks like a video. Title ≤ 90
 * characters, description ≤ 4000, up to 35 photos.
 */
export async function tiktokPhotoStep(a: TikTokApp, token: string, t: Target, o: { slides: () => Promise<string[]>; choices: TikTokChoices; onStepId: (id: string) => Promise<void> }, deps: PlatformDeps = {}): Promise<StepResult> {
  if (t.stepId) return tiktokStep(a, token, t, { bytes: async () => new Uint8Array(), durationSec: 0, choices: o.choices, onStepId: o.onStepId }, deps);
  const info = await creatorInfo(a, token, deps);
  const base = postInfo(t, o.choices, info);
  const urls = await o.slides();
  if (!urls.length || urls.length > 35) throw new TikTokError("photo_count", `a TikTok photo post needs 1–35 photos (this one has ${urls.length})`);
  const text = String(base.title ?? "");
  const d = await call<{ publish_id?: string }>(a, token, deps, "/v2/post/publish/content/init/", {
    media_type: "PHOTO",
    post_mode: "DIRECT_POST",
    post_info: { title: [...text].slice(0, 90).join(""), description: text.slice(0, 4000), privacy_level: base.privacy_level, disable_comment: base.disable_comment, auto_add_music: true, brand_organic_toggle: base.brand_organic_toggle, brand_content_toggle: base.brand_content_toggle },
    source_info: { source: "PULL_FROM_URL", photo_images: urls, photo_cover_index: 0 },
  }, undefined, 1);
  if (!d.publish_id) throw new TikTokError("no_publish_id", "TikTok returned no publish id");
  await o.onStepId(d.publish_id);
  return { kind: "waiting", stepId: d.publish_id, retryInMs: 60_000 };
}

/** Results of public TikTok videos (up to 20 ids per call). Private posts have none. */
export async function tiktokMetrics(a: TikTokApp, token: string, ids: string[], deps: PlatformDeps = {}): Promise<Map<string, Metrics & { shareUrl: string | null }>> {
  const out = new Map<string, Metrics & { shareUrl: string | null }>();
  for (let i = 0; i < ids.length; i += 20) {
    const d = await call<{ videos?: Array<{ id?: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number; share_url?: string }> }>(a, token, deps, "/v2/video/query/", { filters: { video_ids: ids.slice(i, i + 20) } }, { fields: "id,view_count,like_count,comment_count,share_count,share_url" });
    for (const v of d.videos ?? []) if (v.id) out.set(String(v.id), { reach: null, views: v.view_count ?? null, likes: v.like_count ?? null, comments: v.comment_count ?? null, shares: v.share_count ?? null, saves: null, follows: null, shareUrl: v.share_url ?? null });
  }
  return out;
}
