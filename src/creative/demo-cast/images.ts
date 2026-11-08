import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { AssetStore } from "../../ads/assets";
import type { AssetSource } from "../../ads/types";
import type { CreatorKit } from "../kit";
import type { CreativeJob } from "../types";
import type { CastImage, DemoCast } from "./schema";

/**
 * Pictures for the demo cast: a profile photo per person (an invented
 * adult) and a photo per moment (objects and places, no people), made with
 * the image tool the app may use for posts (Growth → Accounts → creator
 * tools; today OpenAI Images — Gemini is only connected for video). Without
 * one, day2 uses the app's own bundled demo pictures, else plain coloured
 * placeholders — and says so. Generated pictures are stored as AI-generated
 * (people: AI person), so every post that shows them carries the AI label.
 */

export const CAST_PURPOSE = "demo-cast";
export const MAX_CAST_IMAGES = 18;

/** Pure. The profile photo prompt — describes clothes and hair only, never a name. */
export function avatarPrompt(p: DemoCast["people"][number]): string {
  return `A casual smartphone selfie of an invented adult, about ${p.age} years old, ${p.look || "friendly smile, casual clothes"}, outdoors in a city on a bright day, head and shoulders, soft background. Photorealistic, natural light.`;
}

/** Pure. A moment's photo prompt — the scene, never a person. */
export function momentPrompt(m: DemoCast["moments"][number], place: DemoCast["places"][number] | undefined): string {
  return `A casual smartphone photo taken by hand: ${m.scene || "a nice spot in the city"}${place ? ` (a ${place.category.replace(/_/g, " ")})` : ""}. Vertical, natural light, slightly imperfect framing like a real phone snapshot.`;
}

/** The app's own bundled demo pictures (e.g. assets/welcome/avatar-*.jpg), split into faces and other photos. */
export function bundledDemoPictures(repoPath: string): { avatars: string[]; photos: string[] } {
  const avatars: string[] = [];
  const photos: string[] = [];
  const skip = /node_modules|\.git|ios|android|build|dist|fonts?|3d|icons?|splash|map|tiles?/i;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.test(e.name)) walk(p, depth + 1);
        continue;
      }
      if (!/\.(jpe?g|png)$/i.test(e.name) || statSync(p).size > 4 * 1024 * 1024 || statSync(p).size < 4096) continue;
      const n = e.name.toLowerCase();
      if (/icon|logo|splash|bg|background|burst|pattern|texture|badge|sticker|@\dx/.test(n)) continue;
      if (/avatar|profile|person|face|user/.test(n)) avatars.push(p);
      // Photos: JPEGs in demo-like folders (PNGs there are usually UI graphics).
      else if (/\.jpe?g$/.test(n) && (/welcome|demo|sample|onboarding|mock|example/.test(dir.toLowerCase()) || /demo|sample/.test(n))) photos.push(p);
    }
  };
  for (const root of ["assets", "src/assets", "app/assets"]) walk(join(repoPath, root), 0);
  return { avatars: avatars.sort(), photos: photos.sort() };
}

/** Pure. A plain PNG (soft vertical gradient of one colour) — the last-resort placeholder. */
export function placeholderPng(w: number, h: number, hex: string): Uint8Array {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.replace("#", "").padEnd(6, "0").slice(i - 1, i + 1), 16) || 200) as [number, number, number];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const k = 1 - (y / h) * 0.25;
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r * k);
      raw[o + 1] = Math.round(g * k);
      raw[o + 2] = Math.round(b * k);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

export type CastImageDeps = {
  /** The app's creator tools for posts, or null (no image tool connected). */
  kit: CreatorKit | null;
  store: AssetStore;
  repoPath: string;
  appName: string;
  /** Placeholder colours (the brand kit's). */
  colors: string[];
  log?: (t: string) => void;
};

/**
 * Adds pictures to every person and moment, in place. Generated first; on
 * no tool (or a refused/failed job) the app's bundled demo pictures; then
 * placeholders. Returns the cast with `images` saying what was used.
 */
export async function addCastImages(cast: DemoCast, d: CastImageDeps): Promise<DemoCast> {
  const dir = mkdtempSync(join(tmpdir(), "day2-cast-"));
  const bundled = bundledDemoPictures(d.repoPath);
  const sources = new Set<CastImage["source"]>();
  const failures: string[] = [];
  let made = 0;
  const tool = (job: CreativeJob) => (d.kit && made < MAX_CAST_IMAGES ? d.kit.pick(job) : null);
  const put = async (file: string, label: string, kind: "avatar" | "photo", meta: Omit<CastImage, "assetId" | "file">, toolId: AssetSource = "upload"): Promise<CastImage> => {
    const png = /\.png$/i.test(file);
    const a = await d.store.put(file, { appId: cast.appId, purpose: CAST_PURPOSE, label, kind: "image", ratio: kind === "avatar" ? "1:1" : "4:5", width: 1024, height: kind === "avatar" ? 1024 : 1536, mime: png ? "image/png" : "image/jpeg", source: toolId, aiGenerated: meta.aiGenerated, aiPerson: meta.aiPerson });
    sources.add(meta.source);
    return { ...meta, assetId: a.id, file: a.path };
  };
  const one = async (kind: "avatar" | "photo", k: number, label: string, prompt: string): Promise<CastImage> => {
    const job: CreativeJob = { capability: "image", prompt, ratio: kind === "avatar" ? "1:1" : "4:5", appName: d.appName, subject: kind === "avatar" ? "fictional_person" : "scene" };
    const c = tool(job);
    if (c && d.kit) {
      try {
        const r = await d.kit.run(c, job, dir);
        made++;
        return await put(r.file, label, kind, { source: "generated", aiGenerated: true, aiPerson: kind === "avatar" || r.aiPerson, tool: r.made.name }, r.made.tool as AssetSource);
      } catch (err) {
        failures.push((err as Error).message.slice(0, 120));
      }
    }
    const pool = kind === "avatar" ? bundled.avatars : bundled.photos;
    if (pool.length) {
      const src = pool[k % pool.length]!;
      const copy = join(dir, `bundled-${kind}-${k}-${basename(src)}`);
      writeFileSync(copy, await Bun.file(src).bytes());
      // The app's own pictures: whoever shipped them in the app vouched for them; day2 doesn't know they're AI.
      return put(copy, label, kind, { source: "bundled", aiGenerated: false, aiPerson: false, tool: null });
    }
    const file = join(dir, `placeholder-${kind}-${k}.png`);
    writeFileSync(file, placeholderPng(kind === "avatar" ? 256 : 256, kind === "avatar" ? 256 : 384, d.colors[k % Math.max(1, d.colors.length)] ?? "#dddddd"));
    return put(file, label, kind, { source: "placeholder", aiGenerated: false, aiPerson: false, tool: null });
  };
  try {
    for (const [k, p] of cast.people.entries()) p.avatar = await one("avatar", k, `Demo cast: ${p.displayName}`, avatarPrompt(p));
    for (const [k, m] of cast.moments.entries()) m.photo = await one("photo", k, `Demo cast: moment ${m.key}`, momentPrompt(m, cast.places.find((x) => x.key === m.place)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const list = [...sources];
  const source = list.length === 1 ? list[0]! : list.length ? "mixed" : "none";
  const note =
    source === "generated"
      ? `Profile photos and moment photos made with ${[...new Set(cast.people.map((p) => p.avatar?.tool).filter(Boolean))].join(", ") || "an image tool"} — invented people, marked as AI-generated on every post that shows them.`
      : !d.kit || !failures.length
        ? `No image tool is connected for posts (Growth → Accounts), so day2 used ${sources.has("bundled") ? "the demo pictures bundled in your app" : "plain coloured placeholders"}${sources.has("bundled") && sources.has("placeholder") ? " and placeholders" : ""}. Connect OpenAI Images and press Regenerate for real-looking photos.`
        : `Some pictures couldn't be made (${failures[0]}); day2 used ${sources.has("bundled") ? "your app's bundled demo pictures" : "placeholders"} for those.`;
  return { ...cast, images: { source, note } };
}
