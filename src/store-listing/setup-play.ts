import type { PlayCredential } from "../mobile-release/credentials";
import { PlayError } from "../mobile-release/play";
import { playHttp } from "./play-listing";

/**
 * Google Play Developer API v3 for store setup — the same service account
 * day2 releases with. Every change goes through one edit, validated and
 * committed (ERROR_IF_IN_REVIEW); reads use an edit that is deleted again.
 *
 *  - edits.details (get / patch): contactEmail, contactPhone,
 *    contactWebsite, defaultLanguage;
 *  - edits.images (list / deleteall / upload) per language and AppImageType:
 *    icon, featureGraphic, phoneScreenshots, sevenInchScreenshots,
 *    tenInchScreenshots;
 *  - edits.listings (patch): `video`, the YouTube promo video;
 *  - edits.tracks (list): which tracks' newest release has release notes.
 *
 * The app's category and tags are not in the API (AppDetails has no
 * category field), so they are a guided step.
 */

export type AppDetails = { defaultLanguage?: string; contactWebsite?: string; contactEmail?: string; contactPhone?: string };
export type PlayImageType = "icon" | "featureGraphic" | "phoneScreenshots" | "sevenInchScreenshots" | "tenInchScreenshots";

export type PlaySetupClient = ReturnType<typeof createPlaySetup>;

export function createPlaySetup(cred: PlayCredential, deps: Parameters<typeof playHttp>[1] = {}) {
  const { api, inEdit, uploadImage } = playHttp(cred, deps);
  const enc = encodeURIComponent;

  return {
    async details(pkg: string): Promise<AppDetails> {
      return inEdit(pkg, false, ({ path }) => api<AppDetails>(`${path}/details`));
    },

    /** Changes only the given fields (edits.details.patch: fields left out stay as they are). */
    async setDetails(pkg: string, change: AppDetails): Promise<void> {
      if (!Object.keys(change).length) return;
      await inEdit(pkg, true, async ({ path }) => {
        await api(`${path}/details`, { method: "PATCH", json: change });
      });
    },

    /** How many images of a type a language has. */
    async imageCounts(pkg: string, language: string, types: PlayImageType[]): Promise<Record<string, number>> {
      return inEdit(pkg, false, async ({ path }) => {
        const out: Record<string, number> = {};
        for (const t of types) {
          try {
            const r = await api<{ images?: unknown[] }>(`${path}/listings/${enc(language)}/${t}`);
            out[t] = r?.images?.length ?? 0;
          } catch (err) {
            if (err instanceof PlayError && err.status === 404) out[t] = 0;
            else throw err;
          }
        }
        return out;
      });
    },

    /** Replaces a language's images of one type (all of them deleted, the files uploaded), in one committed edit. */
    async replaceImages(pkg: string, language: string, type: PlayImageType, files: string[]): Promise<number> {
      const max = type === "icon" || type === "featureGraphic" ? 1 : 8;
      return inEdit(pkg, true, async ({ path, id }) => {
        await api(`${path}/listings/${enc(language)}/${type}`, { method: "DELETE" });
        let n = 0;
        for (const f of files.slice(0, max)) {
          await uploadImage(pkg, id, language, type, f);
          n++;
        }
        return n;
      });
    },

    /** The promo video per language (empty string when none). */
    async videos(pkg: string): Promise<Record<string, string>> {
      return inEdit(pkg, false, async ({ path }) => {
        const r = await api<{ listings?: Array<{ language?: string; video?: string }> }>(`${path}/listings`);
        return Object.fromEntries((r?.listings ?? []).filter((l) => l.language).map((l) => [l.language!, l.video ?? ""]));
      });
    },

    async setVideo(pkg: string, languages: string[], url: string): Promise<void> {
      if (!languages.length) return;
      await inEdit(pkg, true, async ({ path }) => {
        for (const l of languages) await api(`${path}/listings/${enc(l)}`, { method: "PATCH", json: { language: l, video: url } });
      });
    },

    /** Each track's newest release and the languages its release notes cover. */
    async trackNotes(pkg: string): Promise<Array<{ track: string; release: string | null; languages: string[] }>> {
      return inEdit(pkg, false, async ({ path }) => {
        const r = await api<{ tracks?: Array<{ track?: string; releases?: Array<{ name?: string; status?: string; releaseNotes?: Array<{ language?: string }> }> }> }>(`${path}/tracks`);
        return (r?.tracks ?? []).map((t) => {
          const rel = (t.releases ?? []).at(-1);
          return { track: t.track ?? "", release: rel?.name ?? null, languages: (rel?.releaseNotes ?? []).map((n) => n.language ?? "").filter(Boolean) };
        });
      });
    },
  };
}
