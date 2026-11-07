import { request } from "../ads/http";
import { graphAll, graphClient, type GraphCall } from "../ads/platforms/meta";
import { PlatformError, type PlatformDeps } from "../ads/types";
import type { Metrics, PostFormat, Target } from "./types";

/**
 * Publishing on Instagram and a Facebook Page through the Graph API, with
 * the Page access token the owner's Facebook sign-in gives day2 ("Instagram
 * API with Facebook Login": the Instagram professional account linked to
 * the Page; graph.facebook.com). Built from Meta's docs (v25/v26) — not yet
 * run against a real account.
 *
 *  Instagram  POST /{ig-user-id}/media (image_url | video_url + media_type
 *             REELS / STORIES, caption, share_to_feed) → container id;
 *             GET /{container}?fields=status_code until FINISHED;
 *             GET /{ig-user-id}/content_publishing_limit; then
 *             POST /{ig-user-id}/media_publish creation_id.
 *  Page photo POST /{page-id}/photos url, caption, published=true.
 *  Page Reel  POST /{page-id}/video_reels upload_phase=start → video_id;
 *             POST rupload.facebook.com/video-upload/{v}/{video_id}
 *             (file_url header); POST /{page-id}/video_reels
 *             upload_phase=finish, video_state=PUBLISHED, description.
 *
 * Each publish is a small state machine (`step`), so a slow container or a
 * crash halfway never posts twice: the id the platform returns first is
 * kept, and the next step continues from it.
 */

export type StepResult =
  | { kind: "waiting"; stepId: string; retryInMs: number }
  | { kind: "published"; externalId: string; permalink: string | null; note?: string }
  /** The container/upload failed on the platform's side: start over (counts as an attempt). */
  | { kind: "restart"; reason: string }
  /** A publishing limit: try again later, no attempt used. */
  | { kind: "deferred"; untilMs: number; reason: string };

export type MetaPublishCtx = {
  pageId: string;
  pageToken: string;
  igUserId: string | null;
  appSecret?: string;
  apiVersion: string;
  deps: PlatformDeps;
};

/**
 * Every call that creates or publishes something runs once: a timeout after
 * the platform already made the post must not post it again. The next pass
 * continues from the saved id or looks the post up first (`resuming`).
 */
const ONCE = 1;

const graphOf = (c: MetaPublishCtx): GraphCall => graphClient({ token: c.pageToken, appSecret: c.appSecret, apiVersion: c.apiVersion }, c.deps);

/** The Facebook sign-in's permissions for organic posting and its results. */
export const SOCIAL_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "read_insights",
] as const;

/** What publishing needs, by platform — to tell the owner exactly what's missing. */
export const NEEDED_SCOPES = {
  instagram: ["instagram_basic", "instagram_content_publish", "pages_read_engagement"],
  facebook: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
  instagramInsights: ["instagram_manage_insights"],
  facebookInsights: ["read_insights"],
} as const;

export type PublishPage = { pageId: string; name: string; pageToken: string; canPost: boolean; ig: { id: string; username: string | null } | null };

/**
 * The Pages the signed-in person can post as, each with its Page access
 * token (long-lived when the user token is) and linked Instagram
 * professional account.
 */
export async function listPublishPages(userToken: string, o: { appSecret?: string; apiVersion: string }, deps: PlatformDeps = {}): Promise<PublishPage[]> {
  const g = graphClient({ token: userToken, appSecret: o.appSecret, apiVersion: o.apiVersion }, deps);
  const rows = await graphAll<{ id: string; name?: string; access_token?: string; tasks?: string[]; instagram_business_account?: { id: string; username?: string } }>(g, "pages", "me/accounts", {
    fields: "id,name,access_token,tasks,instagram_business_account{id,username}",
    limit: 100,
  });
  return rows
    .filter((p) => p.access_token)
    .map((p) => ({
      pageId: p.id,
      name: p.name ?? p.id,
      pageToken: p.access_token!,
      canPost: !p.tasks || p.tasks.includes("CREATE_CONTENT") || p.tasks.includes("MANAGE"),
      ig: p.instagram_business_account?.id ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? null } : null,
    }));
}

/** Business or Creator: both publish through this path (Graph: account_type isn't readable for every account, so it's best-effort). */
export async function igAccountType(c: MetaPublishCtx): Promise<string | null> {
  if (!c.igUserId) return null;
  try {
    const r = await graphOf(c)<{ username?: string; account_type?: string }>("instagram account", "GET", c.igUserId, { query: { fields: "username" } });
    return r.account_type ?? null;
  } catch {
    return null;
  }
}

/** Instagram's own count of API posts in the last 24 h. */
export async function igPublishingLimit(c: MetaPublishCtx): Promise<{ used: number; total: number } | null> {
  if (!c.igUserId) return null;
  try {
    const r = await graphOf(c)<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>("publishing limit", "GET", `${c.igUserId}/content_publishing_limit`, { query: { fields: "quota_usage,config" } });
    const d = r.data?.[0];
    return d ? { used: d.quota_usage ?? 0, total: d.config?.quota_total ?? 100 } : null;
  } catch {
    return null;
  }
}

const captionOf = (t: Target) => [t.caption.trim(), t.hashtags.length ? t.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ") : ""].filter(Boolean).join("\n\n");
export { captionOf };

/** One step of publishing an Instagram target. `urls.media` is the public link to its image or video. */
export async function instagramStep(c: MetaPublishCtx, t: Target, urls: { media: string; cover?: string | null }, kind: "image" | "video"): Promise<StepResult> {
  if (!c.igUserId) throw new PlatformError("meta", "no Instagram account is linked to the Page");
  const g = graphOf(c);
  if (!t.stepId) {
    const caption = t.format === "story" ? undefined : captionOf(t);
    const form: Record<string, unknown> =
      t.format === "feed"
        ? { image_url: urls.media, caption }
        : t.format === "story"
          ? kind === "video"
            ? { media_type: "STORIES", video_url: urls.media }
            : { media_type: "STORIES", image_url: urls.media }
          : { media_type: "REELS", video_url: urls.media, caption, share_to_feed: "true", ...(urls.cover ? { cover_url: urls.cover } : {}) };
    const r = await g<{ id?: string }>("create Instagram container", "POST", `${c.igUserId}/media`, { form, retries: ONCE });
    if (!r.id) throw new PlatformError("meta", "Instagram returned no container id");
    return { kind: "waiting", stepId: r.id, retryInMs: kind === "video" ? 20_000 : 3_000 };
  }
  const s = await g<{ status_code?: string; status?: string }>("container status", "GET", t.stepId, { query: { fields: "status_code,status" } });
  switch (s.status_code) {
    case "IN_PROGRESS":
      return { kind: "waiting", stepId: t.stepId, retryInMs: 30_000 };
    case "ERROR":
    case "EXPIRED":
      return { kind: "restart", reason: `Instagram couldn't process the media (${s.status_code}${s.status ? `: ${s.status}` : ""})` };
    case "PUBLISHED": {
      // Published before, but the id wasn't kept (a crash right after): find it instead of posting again.
      const found = await findRecentIgMedia(c, t);
      return { kind: "published", externalId: found?.id ?? t.stepId, permalink: found?.permalink ?? null, note: found ? undefined : "Published; Instagram didn't return the post's id." };
    }
    case "FINISHED": {
      const limit = await igPublishingLimit(c);
      if (limit && limit.used >= limit.total) return { kind: "deferred", untilMs: 3_600_000, reason: `Instagram's limit of ${limit.total} API posts a day is reached` };
      const p = await g<{ id?: string }>("publish on Instagram", "POST", `${c.igUserId}/media_publish`, { form: { creation_id: t.stepId }, retries: ONCE });
      if (!p.id) throw new PlatformError("meta", "Instagram returned no media id");
      const info = await g<{ permalink?: string }>("post link", "GET", p.id, { query: { fields: "permalink" } }).catch(() => ({}) as { permalink?: string });
      return { kind: "published", externalId: p.id, permalink: info.permalink ?? null };
    }
    default:
      return { kind: "waiting", stepId: t.stepId, retryInMs: 30_000 };
  }
}

async function findRecentIgMedia(c: MetaPublishCtx, t: Target): Promise<{ id: string; permalink: string | null } | null> {
  try {
    const r = await graphOf(c)<{ data?: Array<{ id: string; caption?: string; permalink?: string; timestamp?: string }> }>("recent posts", "GET", `${c.igUserId}/media`, { query: { fields: "id,caption,permalink,timestamp", limit: 10 } });
    const want = t.caption.trim().slice(0, 60);
    const hit = (r.data ?? []).find((m) => (m.caption ?? "").trim().startsWith(want) && (!t.claimedAt || !m.timestamp || Date.parse(m.timestamp) >= Date.parse(t.claimedAt) - 120_000));
    return hit ? { id: hit.id, permalink: hit.permalink ?? null } : null;
  } catch {
    return null;
  }
}

/** A Page post that may have gone out before the id was kept. */
async function findRecentPagePost(c: MetaPublishCtx, t: Target): Promise<{ id: string; permalink: string | null } | null> {
  try {
    const r = await graphOf(c)<{ data?: Array<{ id: string; message?: string; created_time?: string; permalink_url?: string }> }>("recent Page posts", "GET", `${c.pageId}/published_posts`, { query: { fields: "id,message,created_time,permalink_url", limit: 10 } });
    const want = t.caption.trim().slice(0, 60);
    const hit = (r.data ?? []).find((m) => (m.message ?? "").trim().startsWith(want) && (!t.claimedAt || !m.created_time || Date.parse(m.created_time) >= Date.parse(t.claimedAt) - 120_000));
    return hit ? { id: hit.id, permalink: hit.permalink_url ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * One step of a Facebook Page target. A photo post is one call; when a
 * claimed photo post has no id (the outcome of the last try is unknown),
 * the Page's recent posts are checked first, so it never goes out twice.
 */
export async function facebookStep(c: MetaPublishCtx, t: Target, urls: { media: string }, opts: { resuming: boolean }): Promise<StepResult> {
  const g = graphOf(c);
  if (t.format === "fb_post") {
    if (opts.resuming) {
      const found = await findRecentPagePost(c, t);
      if (found) return { kind: "published", externalId: found.id, permalink: found.permalink };
    }
    const r = await g<{ id?: string; post_id?: string }>("post on the Page", "POST", `${c.pageId}/photos`, { form: { url: urls.media, caption: captionOf(t), published: "true" }, retries: ONCE });
    const id = r.post_id ?? r.id;
    if (!id) throw new PlatformError("meta", "Facebook returned no post id");
    const info = await g<{ permalink_url?: string }>("post link", "GET", id, { query: { fields: "permalink_url" } }).catch(() => ({}) as { permalink_url?: string });
    return { kind: "published", externalId: id, permalink: info.permalink_url ?? null };
  }
  // Reel: start → upload (Facebook fetches the file) → finish → ready.
  const [, videoId, phase] = (t.stepId ?? "").split(":");
  if (!videoId) {
    const r = await g<{ video_id?: string }>("start the Reel upload", "POST", `${c.pageId}/video_reels`, { form: { upload_phase: "start" }, retries: ONCE });
    if (!r.video_id) throw new PlatformError("meta", "Facebook returned no video id");
    return { kind: "waiting", stepId: `vid:${r.video_id}:started`, retryInMs: 0 };
  }
  if (phase === "started") {
    const r = await request<{ success?: boolean }>("meta", c.deps, `https://rupload.facebook.com/video-upload/${c.apiVersion}/${videoId}`, { method: "POST", headers: { authorization: `OAuth ${c.pageToken}`, file_url: urls.media }, retries: ONCE });
    if (r && r.success === false) return { kind: "restart", reason: "Facebook couldn't fetch the video" };
    return { kind: "waiting", stepId: `vid:${videoId}:uploaded`, retryInMs: 0 };
  }
  if (phase === "uploaded") {
    await g("publish the Reel", "POST", `${c.pageId}/video_reels`, { form: { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: captionOf(t) }, retries: ONCE });
    return { kind: "waiting", stepId: `vid:${videoId}:finished`, retryInMs: 60_000 };
  }
  const s = await g<{ status?: { video_status?: string; processing_phase?: { status?: string }; publishing_phase?: { status?: string; errors?: Array<{ message?: string }> } }; permalink_url?: string }>("Reel status", "GET", videoId, { query: { fields: "status,permalink_url" } });
  const pub = s.status?.publishing_phase?.status;
  if (s.status?.video_status === "error" || pub === "error") return { kind: "restart", reason: `Facebook couldn't publish the Reel${s.status?.publishing_phase?.errors?.[0]?.message ? `: ${s.status.publishing_phase.errors[0].message}` : ""}` };
  if (pub === "complete" || s.status?.video_status === "ready" || s.status?.video_status === "published") {
    return { kind: "published", externalId: videoId, permalink: s.permalink_url ? (s.permalink_url.startsWith("http") ? s.permalink_url : `https://www.facebook.com${s.permalink_url}`) : null };
  }
  return { kind: "waiting", stepId: t.stepId!, retryInMs: 60_000 };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const emptyMetrics = (): Metrics => ({ reach: null, views: null, likes: null, comments: null, shares: null, saves: null, follows: null });

const IG_METRICS: Record<"feed" | "reel" | "story", string[]> = {
  feed: ["reach", "views", "likes", "comments", "shares", "saved", "follows"],
  reel: ["reach", "views", "likes", "comments", "shares", "saved"],
  story: ["reach", "views", "shares", "follows", "replies"],
};

/** An Instagram post's results (insights; needs instagram_manage_insights). */
export async function instagramMetrics(c: MetaPublishCtx, mediaId: string, format: PostFormat): Promise<Metrics> {
  const list = IG_METRICS[format === "feed" ? "feed" : format === "story" ? "story" : "reel"];
  const r = await graphOf(c)<{ data?: Array<{ name: string; values?: Array<{ value?: number }>; total_value?: { value?: number } }> }>("Instagram results", "GET", `${mediaId}/insights`, { query: { metric: list.join(",") } });
  const v = (name: string) => {
    const d = r.data?.find((x) => x.name === name);
    return num(d?.total_value?.value ?? d?.values?.[0]?.value);
  };
  return { reach: v("reach"), views: v("views"), likes: v("likes"), comments: v("comments") ?? v("replies"), shares: v("shares"), saves: v("saved"), follows: v("follows") };
}

/** A Page post's results: reactions, comments and shares from the post itself (always readable), views best-effort from insights. */
export async function facebookMetrics(c: MetaPublishCtx, id: string, format: PostFormat): Promise<Metrics> {
  const g = graphOf(c);
  const m = emptyMetrics();
  if (format === "fb_post") {
    const r = await g<{ shares?: { count?: number }; reactions?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>("Facebook results", "GET", id, { query: { fields: "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)" } });
    m.likes = num(r.reactions?.summary?.total_count);
    m.comments = num(r.comments?.summary?.total_count);
    m.shares = num(r.shares?.count) ?? 0;
    // Views (the metric that replaced impressions in 2025): best-effort — the name isn't verified against a real Page yet.
    const ins = await g<{ data?: Array<{ name: string; values?: Array<{ value?: number }> }> }>("Facebook views", "GET", `${id}/insights`, { query: { metric: "post_media_view,post_total_media_view_unique" } }).catch(() => null);
    m.views = num(ins?.data?.find((d) => d.name === "post_media_view")?.values?.[0]?.value);
    m.reach = num(ins?.data?.find((d) => d.name === "post_total_media_view_unique")?.values?.[0]?.value);
    return m;
  }
  const r = await g<{ likes?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>("Reel results", "GET", id, { query: { fields: "likes.summary(total_count).limit(0),comments.summary(total_count).limit(0)" } });
  m.likes = num(r.likes?.summary?.total_count);
  m.comments = num(r.comments?.summary?.total_count);
  const ins = await g<{ data?: Array<{ name: string; values?: Array<{ value?: number }> }> }>("Reel views", "GET", `${id}/video_insights`, { query: { metric: "blue_reels_play_count,post_impressions_unique" } }).catch(() => null);
  m.views = num(ins?.data?.find((d) => d.name === "blue_reels_play_count")?.values?.[0]?.value);
  m.reach = num(ins?.data?.find((d) => d.name === "post_impressions_unique")?.values?.[0]?.value);
  return m;
}
