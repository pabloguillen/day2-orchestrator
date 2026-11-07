import { createHash } from "node:crypto";
import type { MadeWith } from "../creative/types";
/**
 * Organic social posts (docs/social.md): day2 makes posts for an app from
 * its real screens and Brand DNA, the owner approves them (by default), and
 * day2 publishes them on the owner's own Instagram, Facebook Page and
 * TikTok — then reads how they did and makes the next ones better.
 */

export const SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** Which sign-in a platform needs: Instagram and the Page come with one Facebook sign-in. */
export type SocialNetwork = "meta" | "tiktok";
export const networkOf = (p: SocialPlatform): SocialNetwork => (p === "tiktok" ? "tiktok" : "meta");

export const POST_FORMATS = ["reel", "feed", "story", "fb_post", "fb_reel", "tiktok_video", "tiktok_photo"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

export const FORMAT_PLATFORM: Record<PostFormat, SocialPlatform> = {
  reel: "instagram",
  feed: "instagram",
  story: "instagram",
  fb_post: "facebook",
  fb_reel: "facebook",
  tiktok_video: "tiktok",
  tiktok_photo: "tiktok",
};

export const FORMAT_LABEL: Record<PostFormat, string> = {
  reel: "Instagram Reel",
  feed: "Instagram post",
  story: "Instagram Story",
  fb_post: "Facebook post",
  fb_reel: "Facebook Reel",
  tiktok_video: "TikTok video",
  tiktok_photo: "TikTok photo post",
};

export type PostStatus = "draft" | "waiting_approval" | "approved" | "publishing" | "published" | "failed" | "declined";
export type TargetStatus = "pending" | "publishing" | "published" | "failed" | "skipped";

/** The fixed words posts are described with (hooks, topics, time slots) — what the learning keeps; never post texts. */
export const HOOK_STYLES = ["question", "how_to", "relatable_moment", "feature_demo", "tip", "before_after", "challenge", "behind_the_scenes"] as const;
export type HookStyle = (typeof HOOK_STYLES)[number];
export const TOPICS = ["feature", "use_case", "tip", "story", "seasonal", "community", "progress", "fun"] as const;
export type Topic = (typeof TOPICS)[number];
export const TIME_SLOTS = ["morning", "midday", "afternoon", "evening", "late"] as const;
export type TimeSlot = (typeof TIME_SLOTS)[number];

/** How the visual was made: the allocator's format arms for social_content. */
export const SOCIAL_ARMS = ["motion-graphics-short-video", "app-walkthrough-short-video", "ugc-style-short-video", "generated-broll-short-video", "static-image-post"] as const;
export type SocialArm = (typeof SOCIAL_ARMS)[number];

export type Metrics = {
  reach: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  follows: number | null;
};
export type MetricsWindow = "24h" | "72h" | "7d";
export type MetricsSnapshot = { window: MetricsWindow; at: string; metrics: Metrics; note?: string };

export type Target = {
  platform: SocialPlatform;
  format: PostFormat;
  /** The image or video this placement shows (ad-assets store). */
  assetId: string;
  coverAssetId?: string | null;
  caption: string;
  hashtags: string[];
  status: TargetStatus;
  /** Instagram container / Facebook video / TikTok publish id — kept as soon as the platform returns it, so a retry continues instead of posting twice. */
  stepId?: string | null;
  /** The published media / post / video id. */
  externalId?: string | null;
  permalink?: string | null;
  /** When the target was claimed for publishing (the start of the attempt). */
  claimedAt?: string | null;
  /** Held by one publisher until then (10 minutes), so two can never work on it at once. */
  leaseUntil?: string | null;
  attempts: number;
  nextAttemptAt?: string | null;
  error?: string | null;
  note?: string | null;
  publishedAt?: string | null;
  metrics: MetricsSnapshot[];
  /** Taps on the post's own smart link tag (where the platform allows a link). */
  linkTag?: string | null;
};

/** TikTok's required choices (content sharing guidelines): picked by the owner, never defaulted for privacy. */
export type TikTokChoices = {
  privacyLevel: string | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** Commercial content disclosure. */
  disclose: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  /** Label as AI-generated (set by day2 when the video is generated). */
  isAigc: boolean;
};

export type Post = {
  id: string;
  appId: string;
  /** Posts made together (same idea, Meta and TikTok separately) share a group. */
  group: string;
  status: PostStatus;
  kind: "video" | "image";
  language: string;
  idea: { topic: Topic; hook: HookStyle; title: string; brandAngle: string | null; trend: string | null };
  /** `tools`: the creator tools that made the media (docs/creator-tools.md), shown as "Made with …". */
  source: { arm: SocialArm; armKey: string; experimentId: string | null; made: string; tools?: MadeWith[] };
  targets: Target[];
  scheduledAt: string | null;
  timeSlot: TimeSlot | null;
  /** Owner-facing reason the time was picked. */
  timeWhy: string | null;
  safety: { ok: boolean; issues: string[]; checkedAt: string };
  tiktok?: TikTokChoices | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  /** contentHash() of what was approved: checked again right before publishing. */
  approvedHash?: string | null;
  declinedReason?: string | null;
  edited?: boolean;
  costCredits: number;
  /** Organic post that did unusually well: a candidate for paid boosting once paid ads unlock. */
  boostCandidate?: boolean;
  /** Installs estimated from install spikes after the post (never exact). */
  installEstimate?: { installs: number; basis: string } | null;
  /** Fed into the allocator and cross-app learning already (windows). */
  learned?: MetricsWindow[];
  createdAt: string;
  updatedAt: string;
};

export type SocialSettings = {
  /** "Posts go out on their own" — off by default. TikTok posts always ask (TikTok requires the creator's OK per post). */
  autoPublish: boolean;
  /** Kill switch: nothing is made or published while paused. */
  paused: boolean;
  /** Which platforms to post on (default: every connected one). */
  platforms: SocialPlatform[] | null;
};

export const DEFAULT_SOCIAL_SETTINGS: SocialSettings = { autoPublish: false, paused: false, platforms: null };

/** What day2 may post per platform per 24 hours, at most — far below the platforms' own limits (IG 100, FB Reels 30, TikTok ~15), so quality beats volume. */
export const DAILY_LIMIT: Record<SocialPlatform, number> = { instagram: 3, facebook: 3, tiktok: 2 };
export const MAX_ATTEMPTS = 5;

/**
 * What the owner approves: every word, hashtag, media file and placement,
 * the title and TikTok's choices (not the time, not publishing progress).
 * Pure.
 */
export function contentHash(p: Pick<Post, "targets" | "idea" | "tiktok">): string {
  const body = {
    title: p.idea.title,
    targets: p.targets.map((t) => [t.platform, t.format, t.assetId, t.coverAssetId ?? null, t.caption, t.hashtags]),
    tiktok: p.tiktok ?? null,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
