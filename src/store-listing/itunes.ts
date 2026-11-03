import type { Competitor, KeywordStat } from "./types";

/**
 * Apple's public iTunes Search API (no key): what the App Store returns for
 * a search term in a country, and an app's public details by id. It has no
 * search popularity and no subtitles — day2 reads a competitor's subtitle
 * from its public App Store page when it can (best effort).
 */

const SEARCH = "https://itunes.apple.com/search";
const LOOKUP = "https://itunes.apple.com/lookup";

type Hit = { trackId?: number; trackName?: string; sellerName?: string; averageUserRating?: number; userRatingCount?: number; primaryGenreName?: string; trackViewUrl?: string; version?: string; averageUserRatingForCurrentVersion?: number; userRatingCountForCurrentVersion?: number };

export type Itunes = {
  search(term: string, country: string, limit?: number): Promise<Hit[]>;
  lookup(id: string, country: string): Promise<Hit | null>;
  lookupBundle(bundleId: string, country: string): Promise<Hit | null>;
  subtitle(url: string): Promise<string | null>;
};

export function createItunes(doFetch: typeof fetch = fetch): Itunes {
  const get = async (url: string) => {
    const r = await doFetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "day2-store/1" } });
    if (!r.ok) throw new Error(`the App Store search answered ${r.status}`);
    return (await r.json()) as { results?: Hit[] };
  };
  return {
    async search(term, country, limit = 50) {
      const q = new URLSearchParams({ term, country, entity: "software", limit: String(Math.min(200, limit)) });
      return (await get(`${SEARCH}?${q}`)).results ?? [];
    },
    async lookup(id, country) {
      return (await get(`${LOOKUP}?${new URLSearchParams({ id, country })}`)).results?.[0] ?? null;
    },
    async lookupBundle(bundleId, country) {
      return (await get(`${LOOKUP}?${new URLSearchParams({ bundleId, country })}`)).results?.[0] ?? null;
    },
    async subtitle(url) {
      try {
        const r = await doFetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Mozilla/5.0 (Macintosh) day2-store/1" } });
        if (!r.ok) return null;
        return subtitleFromPage(await r.text());
      } catch {
        return null;
      }
    },
  };
}

/** Pure. The subtitle on a public App Store page (the header's h2), or null. */
export function subtitleFromPage(html: string): string | null {
  const m = html.match(/<h2[^>]*class="[^"]*(?:product-header__subtitle|subtitle)[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  const t = m?.[1]?.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  return t && t.length <= 60 ? t : null;
}

/** Pure. One search's numbers for a term: how many apps, where ours is, how strong the top ones are. */
export function keywordStat(term: string, country: string, hits: Hit[], ownId: string | null): KeywordStat {
  const idx = ownId ? hits.findIndex((h) => String(h.trackId) === ownId) : -1;
  return {
    term,
    country,
    results: hits.length,
    rank: idx >= 0 ? idx + 1 : null,
    topRatings: hits.slice(0, 5).map((h) => h.userRatingCount ?? 0),
    topApps: hits.slice(0, 5).map((h) => h.trackName ?? "").filter(Boolean),
  };
}

/** Pure. A rough difficulty from 0 (open) to 100 (dominated by apps with huge rating counts). */
export function difficulty(k: KeywordStat): number {
  if (!k.topRatings.length) return 0;
  const median = [...k.topRatings].sort((a, b) => a - b)[Math.floor(k.topRatings.length / 2)]!;
  return Math.min(100, Math.round(Math.log10(1 + median) * 20));
}

/**
 * Keyword numbers and competitors for the app: each term searched in each
 * country, and the apps that keep showing up at the top (with subtitles
 * from their pages, when the page has one).
 */
export async function research(itunes: Itunes, o: { terms: string[]; countries: string[]; ownId: string | null; maxCompetitors?: number }): Promise<{ keywords: KeywordStat[]; competitors: Competitor[] }> {
  const keywords: KeywordStat[] = [];
  const seen = new Map<string, { hit: Hit; country: string; score: number }>();
  for (const country of o.countries) {
    for (const term of o.terms.slice(0, 15)) {
      let hits: Hit[] = [];
      try {
        hits = await itunes.search(term, country, 50);
      } catch {
        continue;
      }
      keywords.push(keywordStat(term, country, hits, o.ownId));
      for (const [i, h] of hits.slice(0, 10).entries()) {
        if (!h.trackId || String(h.trackId) === o.ownId) continue;
        const k = `${h.trackId}`;
        const prev = seen.get(k);
        seen.set(k, { hit: h, country, score: (prev?.score ?? 0) + (10 - i) });
      }
    }
  }
  const top = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, o.maxCompetitors ?? 8);
  const competitors: Competitor[] = [];
  for (const { hit: h, country } of top) {
    competitors.push({
      id: String(h.trackId),
      name: h.trackName ?? "",
      subtitle: h.trackViewUrl ? await itunes.subtitle(h.trackViewUrl) : null,
      seller: h.sellerName ?? "",
      rating: typeof h.averageUserRating === "number" ? Math.round(h.averageUserRating * 10) / 10 : null,
      ratings: h.userRatingCount ?? 0,
      genre: h.primaryGenreName ?? null,
      country,
    });
  }
  return { keywords, competitors };
}
