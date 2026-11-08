import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetStore } from "../../ads/assets";
import { dataDir } from "../../day2-paths";
import { CAST_VERSION, type CastImage, type DemoCast } from "./schema";

/**
 * Where an app's demo cast lives: `<data>/demo-cast/<app>/cast.json` (data
 * only — nothing secret; the demo account's password is in the encrypted
 * hosting secrets), its pictures in the asset store (purpose "demo-cast",
 * with the AI flags). Never in the app's repo.
 */

export const castDir = (appId: string) => join(dataDir(), "demo-cast", appId.replace(/[^\w-]/g, "_"));

/** Files are kept out of the saved JSON (paths are resolved from the asset store when loaded). */
const strip = (i: CastImage | null): CastImage | null => (i ? { ...i, file: null } : null);

export function saveCast(cast: DemoCast): void {
  const dir = castDir(cast.appId);
  mkdirSync(dir, { recursive: true });
  const out: DemoCast = { ...cast, people: cast.people.map((p) => ({ ...p, avatar: strip(p.avatar) })), moments: cast.moments.map((m) => ({ ...m, photo: strip(m.photo) })) };
  writeFileSync(join(dir, "cast.json.tmp"), JSON.stringify(out, null, 2));
  renameSync(join(dir, "cast.json.tmp"), join(dir, "cast.json"));
}

export function loadCastRaw(appId: string): DemoCast | null {
  const p = join(castDir(appId), "cast.json");
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf-8")) as DemoCast;
    return c.version === CAST_VERSION && c.appId === appId ? c : null;
  } catch {
    return null;
  }
}

/** The cast with each picture's file on disk (only the app's own "demo-cast" assets). */
export async function loadCast(appId: string, assets: AssetStore): Promise<DemoCast | null> {
  const c = loadCastRaw(appId);
  if (!c) return null;
  const resolve = async (i: CastImage | null): Promise<CastImage | null> => {
    if (!i?.assetId) return i;
    const a = await assets.get(i.assetId).catch(() => null);
    return a && a.appId === appId && a.purpose === "demo-cast" && existsSync(a.path) ? { ...i, file: a.path } : { ...i, file: null };
  };
  for (const p of c.people) p.avatar = await resolve(p.avatar);
  for (const m of c.moments) m.photo = await resolve(m.photo);
  return c;
}

/** Does a post that shows this cast need the AI label? Pure. */
export function castAiFlags(c: DemoCast | null): { aiGenerated: boolean; aiPerson: boolean } {
  if (!c) return { aiGenerated: false, aiPerson: false };
  const imgs = [...c.people.map((p) => p.avatar), ...c.moments.map((m) => m.photo)].filter((x): x is CastImage => Boolean(x));
  return { aiGenerated: imgs.some((i) => i.aiGenerated), aiPerson: imgs.some((i) => i.aiPerson) };
}
