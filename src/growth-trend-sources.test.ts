import { describe, expect, test } from "bun:test";
import {
  parseRedditPostChild,
  parseYoutubeVideoItem,
  renderRedditPostsForPrompt,
  renderYoutubeTrendingForPrompt,
} from "./growth-trend-sources";
import type { RedditPost, YoutubeTrendingVideo } from "./growth-trend-sources";

describe("parseYoutubeVideoItem", () => {
  function item(overrides: Record<string, unknown> = {}) {
    return {
      id: "abc123",
      snippet: { title: "A real trending video", channelTitle: "Real Channel", publishedAt: "2026-01-01T00:00:00.000Z" },
      statistics: { viewCount: "123456" },
      ...overrides,
    };
  }

  test("parses a well-formed item", () => {
    const result = parseYoutubeVideoItem(item());
    expect(result).toEqual({
      title: "A real trending video",
      channelTitle: "Real Channel",
      viewCount: 123456,
      publishedAt: "2026-01-01T00:00:00.000Z",
      videoId: "abc123",
    });
  });

  test("rejects a non-object item", () => {
    expect(parseYoutubeVideoItem(null)).toBeNull();
    expect(parseYoutubeVideoItem("x")).toBeNull();
  });

  test("rejects an item missing snippet.title", () => {
    expect(parseYoutubeVideoItem(item({ snippet: { channelTitle: "c", publishedAt: "p" } }))).toBeNull();
  });

  test("rejects an item missing statistics.viewCount", () => {
    expect(parseYoutubeVideoItem(item({ statistics: {} }))).toBeNull();
  });

  test("rejects an item with a non-numeric viewCount string", () => {
    expect(parseYoutubeVideoItem(item({ statistics: { viewCount: "not-a-number" } }))).toBeNull();
  });

  test("rejects an item missing id", () => {
    const { id, ...rest } = item();
    expect(parseYoutubeVideoItem(rest)).toBeNull();
  });
});

describe("renderYoutubeTrendingForPrompt", () => {
  test("renders an honest placeholder for an empty list", () => {
    expect(renderYoutubeTrendingForPrompt([])).toBe("(no trending videos)");
  });

  test("renders every real video with its title, channel, and views", () => {
    const videos: YoutubeTrendingVideo[] = [
      { title: "T1", channelTitle: "C1", viewCount: 1000, publishedAt: "2026-01-01T00:00:00.000Z", videoId: "v1" },
    ];
    const text = renderYoutubeTrendingForPrompt(videos);
    expect(text).toContain("T1");
    expect(text).toContain("C1");
    expect(text).toContain("1,000");
  });
});

describe("parseRedditPostChild", () => {
  function child(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        title: "A real hot post",
        subreddit: "socialmedia",
        score: 42,
        created_utc: 1735689600,
        permalink: "/r/socialmedia/comments/abc/a_real_hot_post/",
        ...overrides,
      },
    };
  }

  test("parses a well-formed child and converts created_utc to an ISO string", () => {
    const result = parseRedditPostChild(child());
    expect(result?.title).toBe("A real hot post");
    expect(result?.subreddit).toBe("socialmedia");
    expect(result?.score).toBe(42);
    expect(result?.permalink).toBe("/r/socialmedia/comments/abc/a_real_hot_post/");
    expect(result?.createdAt).toBe(new Date(1735689600 * 1000).toISOString());
  });

  test("rejects a non-object child", () => {
    expect(parseRedditPostChild(null)).toBeNull();
  });

  test("rejects a child missing data", () => {
    expect(parseRedditPostChild({})).toBeNull();
  });

  test("rejects a child with a non-numeric score", () => {
    expect(parseRedditPostChild(child({ score: "42" }))).toBeNull();
  });

  test("rejects a child missing permalink", () => {
    const data = child().data as Record<string, unknown>;
    delete data.permalink;
    expect(parseRedditPostChild({ data })).toBeNull();
  });
});

describe("renderRedditPostsForPrompt", () => {
  test("renders an honest placeholder for an empty list", () => {
    expect(renderRedditPostsForPrompt([])).toBe("(no hot posts)");
  });

  test("renders every real post with its subreddit, title, and score", () => {
    const posts: RedditPost[] = [
      { title: "P1", subreddit: "marketing", score: 10, createdAt: "2026-01-01T00:00:00.000Z", permalink: "/r/marketing/x" },
    ];
    const text = renderRedditPostsForPrompt(posts);
    expect(text).toContain("r/marketing");
    expect(text).toContain("P1");
    expect(text).toContain("score 10");
  });
});
