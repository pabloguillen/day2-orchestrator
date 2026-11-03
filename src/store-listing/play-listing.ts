import { redact, request, tokenCache, type RequestInit2 } from "../ads/http";
import { PlatformError } from "../ads/types";
import type { PlayCredential } from "../mobile-release/credentials";
import { PlayError, serviceAccountJwt } from "../mobile-release/play";
import type { PlayListing } from "./types";

/**
 * Google Play Developer API v3 for the store listing — the same service
 * account day2 releases with:
 *
 *  - texts: edits → listings (title, short and full description) per
 *    language, all approved changes in one edit, validated and committed;
 *  - screenshots: edits → images (phoneScreenshots: delete all, upload each);
 *  - reviews: reviews.list (Google returns the last week's reviews with
 *    text) and reviews.reply (≤ 350 characters).
 *
 * Store listing experiments have no API — they're a "Do it with me" walkthrough.
 */

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const PLAY_REPLY_MAX = 350;

export type PlayReview = { id: string; rating: number; body: string; author: string; language: string | null; version: string | null; createdAt: string; reply: string | null };

export type PlayListingClient = ReturnType<typeof createPlayListing>;

type Listing = { language?: string; title?: string; shortDescription?: string; fullDescription?: string; video?: string };

export function createPlayListing(cred: PlayCredential, deps: { fetch?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void>; readFile?: (path: string) => Promise<Uint8Array> } = {}) {
  const now = deps.now ?? (() => new Date());
  const httpDeps = { fetch: deps.fetch, now, sleep: deps.sleep };
  const readFile = deps.readFile ?? (async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer()));

  async function call<T>(url: string, init: RequestInit2 = {}): Promise<T> {
    let res: Response;
    try {
      res = await request<Response>("google", httpDeps, url, { ...init, rawResponse: true });
    } catch (err) {
      if (err instanceof PlatformError) throw new PlayError(err.message.replace(/^google: /, ""), err.status, err.retryable);
      throw err;
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string };
        msg = typeof j.error === "object" && j.error?.message ? j.error.message : typeof j.error === "string" ? j.error : msg;
      } catch {
        /* not JSON */
      }
      throw new PlayError(`${res.status} ${redact(msg)}`, res.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const token = tokenCache(
    async () => {
      const r = await call<{ access_token: string; expires_in: number }>(TOKEN_URL, { method: "POST", form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(cred, now()) } });
      return { accessToken: r.access_token, expiresInSec: r.expires_in };
    },
    () => now().getTime(),
  );
  const api = async <T>(url: string, init: RequestInit2 = {}): Promise<T> => call<T>(url.startsWith("http") ? url : `${BASE}${url}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await token()}` } });
  const app = (pkg: string) => `/applications/${encodeURIComponent(pkg)}`;

  /** Runs `fn` in a fresh edit; commits when asked, deletes the edit otherwise or on failure. */
  async function inEdit<T>(pkg: string, commit: boolean, fn: (edit: { path: string; id: string }) => Promise<T>): Promise<T> {
    const edit = await api<{ id: string }>(`${app(pkg)}/edits`, { method: "POST", json: {} });
    const path = `${app(pkg)}/edits/${encodeURIComponent(edit.id)}`;
    let committed = false;
    try {
      const out = await fn({ path, id: edit.id });
      if (commit) {
        await api(`${path}:validate`, { method: "POST" });
        await api(`${path}:commit`, { method: "POST", query: { changesInReviewBehavior: "ERROR_IF_IN_REVIEW" } });
        committed = true;
      }
      return out;
    } finally {
      if (!committed) await api(path, { method: "DELETE", retries: 1 }).catch(() => {});
    }
  }

  return {
    async readListings(pkg: string): Promise<Record<string, PlayListing>> {
      return inEdit(pkg, false, async ({ path }) => {
        const r = await api<{ listings?: Listing[] }>(`${path}/listings`);
        const out: Record<string, PlayListing> = {};
        for (const l of r?.listings ?? []) if (l.language) out[l.language] = { title: l.title ?? "", shortDescription: l.shortDescription ?? "", fullDescription: l.fullDescription ?? "" };
        return out;
      });
    },

    /** All changes in one edit: each language's listing read, changed fields merged, written back; then committed. */
    async writeListings(pkg: string, byLanguage: Record<string, PlayListing>): Promise<void> {
      await inEdit(pkg, true, async ({ path }) => {
        for (const [language, change] of Object.entries(byLanguage)) {
          let current: Listing = {};
          try {
            current = await api<Listing>(`${path}/listings/${encodeURIComponent(language)}`);
          } catch (err) {
            if (!(err instanceof PlayError && err.status === 404)) throw err;
          }
          const body = { language, title: current.title ?? "", shortDescription: current.shortDescription ?? "", fullDescription: current.fullDescription ?? "", ...(current.video ? { video: current.video } : {}), ...change };
          await api(`${path}/listings/${encodeURIComponent(language)}`, { method: "PUT", json: body });
        }
      });
    },

    /** Replaces a language's phone screenshots (2–8 PNG/JPEG, 16:9 or 9:16). */
    async replacePhoneScreenshots(pkg: string, language: string, files: string[]): Promise<number> {
      return inEdit(pkg, true, async ({ path, id }) => {
        await api(`${path}/listings/${encodeURIComponent(language)}/phoneScreenshots`, { method: "DELETE" });
        let n = 0;
        for (const f of files.slice(0, 8)) {
          const bytes = await readFile(f);
          await api(`${UPLOAD}${app(pkg)}/edits/${encodeURIComponent(id)}/listings/${encodeURIComponent(language)}/phoneScreenshots`, {
            method: "POST",
            query: { uploadType: "media" },
            headers: { "content-type": f.endsWith(".jpg") ? "image/jpeg" : "image/png" },
            raw: bytes,
          });
          n++;
        }
        return n;
      });
    },

    async reviews(pkg: string, o: { max?: number } = {}): Promise<PlayReview[]> {
      type R = {
        reviewId?: string;
        authorName?: string;
        comments?: Array<{
          userComment?: { text?: string; starRating?: number; lastModified?: { seconds?: string | number }; appVersionName?: string; reviewerLanguage?: string };
          developerComment?: { text?: string };
        }>;
      };
      const out: PlayReview[] = [];
      let pageToken: string | undefined;
      do {
        const r = await api<{ reviews?: R[]; tokenPagination?: { nextPageToken?: string } }>(`${app(pkg)}/reviews`, { query: { maxResults: 100, token: pageToken } });
        for (const x of r?.reviews ?? []) {
          const u = x.comments?.find((c) => c.userComment)?.userComment;
          const d = x.comments?.find((c) => c.developerComment)?.developerComment;
          if (!x.reviewId || !u) continue;
          out.push({
            id: x.reviewId,
            rating: Number(u.starRating ?? 0),
            body: (u.text ?? "").trim(),
            author: x.authorName ?? "",
            language: u.reviewerLanguage ?? null,
            version: u.appVersionName ?? null,
            createdAt: new Date(Number(u.lastModified?.seconds ?? 0) * 1000).toISOString(),
            reply: d?.text ?? null,
          });
        }
        pageToken = r?.tokenPagination?.nextPageToken;
      } while (pageToken && out.length < (o.max ?? 300));
      return out;
    },

    async reply(pkg: string, reviewId: string, text: string): Promise<void> {
      await api(`${app(pkg)}/reviews/${encodeURIComponent(reviewId)}:reply`, { method: "POST", json: { replyText: text.slice(0, PLAY_REPLY_MAX) } });
    },
  };
}
