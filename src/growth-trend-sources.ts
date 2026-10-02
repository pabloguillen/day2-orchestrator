/**
 * Legitimate, ToS-compliant trend-data sources beyond TikTok's own
 * Trends page (docs/distribution-intelligence.md, Open question #4 —
 * "which platforms beyond TikTok's Trends page qualify as genuinely
 * real-time-native and publicly accessible").
 *
 * Live verification of `growth-trends.ts`'s Playwright render against
 * TikTok's Creative Center page found a flat HTTP 403 at the edge — an
 * active bot-detection block, not a JS-rendering gap. Getting past that
 * reliably would mean fingerprint spoofing / residential-proxy rotation
 * against a platform whose ToS explicitly forbids automated access —
 * exactly the detection-evasion line this project doesn't cross. These
 * two sources are the real, compliant alternative: both are official,
 * authenticated APIs (an API key / OAuth client-credentials grant, never
 * a scraper), so there's no bot-detection cat-and-mouse to begin with.
 *
 * - **YouTube Data API v3** (`fetchYoutubeTrendingVideos`) — the
 *   official `chart=mostPopular` endpoint. Free-tier, API-key-based.
 *   Needs `YOUTUBE_API_KEY`.
 * - **Reddit's official API** (`fetchRedditHotPosts`) — OAuth2
 *   client-credentials grant (a registered "script" app), not the
 *   unauthenticated `.json` endpoints (which Reddit itself now
 *   rate-limits/blocks for exactly the same bot-detection reasons as
 *   TikTok). Needs `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`/
 *   `REDDIT_USER_AGENT`.
 *
 * Neither fully replaces native TikTok trend granularity — YouTube's
 * `mostPopular` chart is generic trending video, not TikTok's
 * micro-format trend cycles, and Reddit surfaces trend *discussion*, not
 * the trend itself. Both fail closed to an empty result plus an honest
 * `caveat` string (same discipline as `onboarding.ts`'s
 * `fetchCurrentState`) when credentials are missing or a call fails —
 * never silently fabricated, never a hard throw that would crash
 * `researchCurrentTrends`.
 *
 * A fourth, deliberately NOT built option exists and is worth naming:
 * a licensed trend-data vendor (Exploding Topics-style tools) that has
 * already solved compliant TikTok-trend access as a paid product. This
 * would close the TikTok-specific gap these two sources can't fully
 * close — but it directly reverses the margin-preserving "no external
 * tools" stance already decided for this project, so it's documented in
 * docs/distribution-intelligence.md as a real alternative, not built
 * here.
 */

export type YoutubeTrendingVideo = {
  title: string;
  channelTitle: string;
  viewCount: number;
  publishedAt: string;
  videoId: string;
};

const YOUTUBE_MAX_RESULTS = 25;

/** Pure, unit-tested. Fails closed to `null` on any shape mismatch —
 * one malformed item from the real API shouldn't corrupt the whole
 * fetch, `fetchYoutubeTrendingVideos` filters these out rather than
 * throwing. */
export function parseYoutubeVideoItem(item: unknown): YoutubeTrendingVideo | null {
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  const snippet = obj.snippet as Record<string, unknown> | undefined;
  const statistics = obj.statistics as Record<string, unknown> | undefined;
  if (
    typeof obj.id !== "string" ||
    typeof snippet?.title !== "string" ||
    typeof snippet?.channelTitle !== "string" ||
    typeof snippet?.publishedAt !== "string" ||
    typeof statistics?.viewCount !== "string"
  ) {
    return null;
  }
  const viewCount = Number(statistics.viewCount);
  if (!Number.isFinite(viewCount)) return null;
  return {
    title: snippet.title,
    channelTitle: snippet.channelTitle,
    viewCount,
    publishedAt: snippet.publishedAt,
    videoId: obj.id,
  };
}

/** Pure, unit-tested. */
export function renderYoutubeTrendingForPrompt(videos: YoutubeTrendingVideo[]): string {
  if (videos.length === 0) return "(no trending videos)";
  return videos.map((v) => `- "${v.title}" — ${v.channelTitle}, ${v.viewCount.toLocaleString()} views (published ${v.publishedAt})`).join("\n");
}

/** Thin IO wrapper — zero unit coverage, validated only live. Official
 * YouTube Data API v3 `chart=mostPopular`, API-key auth, never scraped.
 * Fails closed to `{ videos: [], caveat }` on a missing key, a non-OK
 * response, or a thrown network error — same shape as
 * `onboarding.ts`'s `fetchCurrentState`. */
export async function fetchYoutubeTrendingVideos(regionCode: string = "US"): Promise<{ videos: YoutubeTrendingVideo[]; caveat: string }> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { videos: [], caveat: "YouTube not queried: YOUTUBE_API_KEY is not set." };
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&maxResults=${YOUTUBE_MAX_RESULTS}&regionCode=${encodeURIComponent(regionCode)}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      return { videos: [], caveat: `YouTube trending query failed (HTTP ${res.status}) — no real data, don't fabricate.` };
    }
    const body = (await res.json()) as { items?: unknown[] };
    const items = Array.isArray(body.items) ? body.items : [];
    const videos = items.map(parseYoutubeVideoItem).filter((v): v is YoutubeTrendingVideo => v !== null);
    return { videos, caveat: videos.length === 0 ? "YouTube query succeeded but returned no parseable videos." : "" };
  } catch (err) {
    return { videos: [], caveat: `YouTube trending query threw (${(err as Error).message}) — no real data.` };
  }
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

export type RedditPost = {
  title: string;
  subreddit: string;
  score: number;
  createdAt: string;
  permalink: string;
};

/** A disclosed, hardcoded starting list — real trend-discussion
 * communities, not an attempt at exhaustive coverage. */
export const DEFAULT_TREND_SUBREDDITS: readonly string[] = ["socialmedia", "TikTokCreators", "marketing"];

const REDDIT_MAX_RESULTS_PER_SUBREDDIT = 15;

/** Pure, unit-tested. Fails closed to `null` on any shape mismatch,
 * same discipline as `parseYoutubeVideoItem`. */
export function parseRedditPostChild(child: unknown): RedditPost | null {
  if (typeof child !== "object" || child === null) return null;
  const data = (child as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (
    typeof obj.title !== "string" ||
    typeof obj.subreddit !== "string" ||
    typeof obj.score !== "number" ||
    typeof obj.created_utc !== "number" ||
    typeof obj.permalink !== "string"
  ) {
    return null;
  }
  return {
    title: obj.title,
    subreddit: obj.subreddit,
    score: obj.score,
    createdAt: new Date(obj.created_utc * 1000).toISOString(),
    permalink: obj.permalink,
  };
}

/** Pure, unit-tested. */
export function renderRedditPostsForPrompt(posts: RedditPost[]): string {
  if (posts.length === 0) return "(no hot posts)";
  return posts.map((p) => `- r/${p.subreddit}: "${p.title}" (score ${p.score}, posted ${p.createdAt})`).join("\n");
}

/** Thin IO wrapper — zero unit coverage, validated only live. Reddit's
 * OAuth2 client-credentials grant (a registered "script" app), never
 * the unauthenticated `.json` endpoints Reddit itself now rate-limits
 * for the same bot-detection reasons as TikTok. Fails closed to `null`
 * on missing credentials or a non-OK token response. */
async function fetchRedditAccessToken(clientId: string, clientSecret: string, userAgent: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string };
    return typeof body.access_token === "string" ? body.access_token : null;
  } catch {
    return null;
  }
}

/** Thin IO wrapper — zero unit coverage, validated only live. One
 * subreddit's failure (private/banned/renamed, rate-limited) never
 * sinks the others — each is fetched independently and skipped on
 * failure rather than aborting the whole call. Fails closed to
 * `{ posts: [], caveat }`, same shape as `fetchYoutubeTrendingVideos`. */
export async function fetchRedditHotPosts(subreddits: readonly string[] = DEFAULT_TREND_SUBREDDITS): Promise<{ posts: RedditPost[]; caveat: string }> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT;
  if (!clientId || !clientSecret || !userAgent) {
    return { posts: [], caveat: "Reddit not queried: REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET/REDDIT_USER_AGENT are not all set." };
  }

  const token = await fetchRedditAccessToken(clientId, clientSecret, userAgent);
  if (!token) {
    return { posts: [], caveat: "Reddit not queried: could not obtain an OAuth access token." };
  }

  const posts: RedditPost[] = [];
  for (const subreddit of subreddits) {
    try {
      const res = await fetch(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/hot?limit=${REDDIT_MAX_RESULTS_PER_SUBREDDIT}`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: { children?: unknown[] } };
      const children = Array.isArray(body.data?.children) ? body.data!.children! : [];
      for (const child of children) {
        const post = parseRedditPostChild(child);
        if (post) posts.push(post);
      }
    } catch {
      // one subreddit's network failure doesn't sink the others
    }
  }
  return { posts, caveat: posts.length === 0 ? "Reddit queried but returned no parseable posts." : "" };
}
