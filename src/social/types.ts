import { createHash } from "node:crypto";
import type { MadeWith } from "../creative/types";
import type { ShotList, TemplateId } from "../creative/templates/types";
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

export const POST_FORMATS = ["reel", "feed", "story", "fb_post", "fb_reel", "tiktok_video", "tiktok_photo", "ig_carousel", "fb_album"] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

export const FORMAT_PLATFORM: Record<PostFormat, SocialPlatform> = {
  reel: "instagram",
  feed: "instagram",
  story: "instagram",
  fb_post: "facebook",
  fb_reel: "facebook",
  tiktok_video: "tiktok",
  tiktok_photo: "tiktok",
  ig_carousel: "instagram",
  fb_album: "facebook",
};

export const FORMAT_LABEL: Record<PostFormat, string> = {
  reel: "Instagram Reel",
  feed: "Instagram post",
  story: "Instagram Story",
  fb_post: "Facebook post",
  fb_reel: "Facebook Reel",
  tiktok_video: "TikTok video",
  tiktok_photo: "TikTok photo post",
  ig_carousel: "Instagram carousel",
  fb_album: "Facebook photos",
};

/** Formats whose media is a list of slides (Target.assetIds, in order). */
export const SLIDE_FORMATS: ReadonlySet<PostFormat> = new Set(["ig_carousel", "fb_album", "tiktok_photo"]);
/** Platform limits on slides: Instagram 10, TikTok photo mode 35, Facebook multi-photo (day2 keeps it at 10). */
export const MAX_SLIDES: Partial<Record<PostFormat, number>> = { ig_carousel: 10, fb_album: 10, tiktok_photo: 35 };

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
  /** The image or video this placement shows (ad-assets store); for slide formats, the first slide. */
  assetId: string;
  /** Slide formats (carousel, album, TikTok photo): every slide, in order. */
  assetIds?: string[] | null;
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
  kind: "video" | "image" | "carousel";
  language: string;
  /** How the visual was designed (docs/creative-quality.md): template, the art director's shot list, the critique. */
  creative?: PostCreative | null;
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

export type PostCreative = {
  template: TemplateId;
  templateLabel: string;
  /** Why day2 picked this template ("a new app's first post explains how it works"). */
  templateWhy: string;
  shots: ShotList;
  /** The critique's weighted score (0–10), the rubric version it used, and its short owner-facing line. */
  score: number;
  rubricVersion: number;
  why: string | null;
  rounds: number;
  bySight: boolean;
  scores: Record<string, number>;
  issues: string[];
  /** "Screens are in English" — shown on the card when the screens aren't in the post's language. */
  screensWarning: string | null;
  /** Variants made for the same idea: the owner picks one ("Use this one"). */
  variant: { set: string; index: number; of: number } | null;
  /** 1:1 slides (the carousel goes out at 4:5; kept for the store pipeline and re-use). */
  squareIds?: string[];
  /** The 9:16 video version when the post goes out as slides (and vice versa). */
  videoId?: string | null;
  /** The screens it was made from (assets), for re-rendering after an edit. */
  screens?: Array<{ id: string; width: number; height: number; language: string | null; statusBar: number; name: string; source: string }>;
  /** The post shows AI-generated (fictional) people or photos — the demo cast. TikTok gets is_aigc; the card says so. */
  aiContent?: { aiGenerated: boolean; aiPerson: boolean; why: string } | null;
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
    targets: p.targets.map((t) => [t.platform, t.format, t.assetId, ...(t.assetIds?.length ? [t.assetIds] : []), t.coverAssetId ?? null, t.caption, t.hashtags]),
    tiktok: p.tiktok ?? null,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
