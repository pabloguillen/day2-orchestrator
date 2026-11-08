import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dataDir } from "../day2-paths";
import { headerSize, localeFor, type CaptureSet } from "./capture";

/**
 * Screens the owner uploads (Growth → Formats → "Upload screenshots"): the
 * fallback when day2 can't capture the app itself. 3–8 phone screenshots
 * per language, PNG or JPEG; each one is checked by its first bytes (not
 * its name or the browser's word), size-checked from its header before
 * anything decodes it, then re-encoded by ffmpeg with the image demuxer
 * forced and only local files allowed — which drops EXIF/GPS/camera data
 * and anything hidden in the file. Kept per app under
 * `<data>/creative-uploads/<app>/<locale>/`, used by chooseScreens right
 * after fresh captures.
 */

export const UPLOAD = { minFiles: 3, maxFiles: 8, maxBytes: 10 * 1024 * 1024, maxTotal: 60 * 1024 * 1024, maxSide: 6000, minWidth: 540, minRatio: 1.5, maxRatio: 2.4 } as const;

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Pure. "png" / "jpeg" from the file's magic bytes, else null. */
export function sniffImage(b: Uint8Array): "png" | "jpeg" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

/** Pure. What's wrong with one file before it is decoded at all. */
export function checkScreenshot(name: string, b: Uint8Array): { kind: "png" | "jpeg"; width: number; height: number } {
  const label = name.replace(/[^\w .-]/g, "").slice(0, 40) || "a file";
  if (!b.byteLength) throw new UploadError(`${label} is empty.`);
  if (b.byteLength > UPLOAD.maxBytes) throw new UploadError(`${label} is over ${UPLOAD.maxBytes / 1024 / 1024} MB.`, 413);
  const kind = sniffImage(b);
  if (!kind) throw new UploadError(`${label} isn't a PNG or JPEG image.`, 415);
  const size = headerSize(b);
  if (!size || !size.width || !size.height) throw new UploadError(`${label}: day2 can't read the image's size.`);
  if (size.width > UPLOAD.maxSide || size.height > UPLOAD.maxSide * 2) throw new UploadError(`${label} is ${size.width}×${size.height} — too large for a phone screenshot.`);
  if (size.width < UPLOAD.minWidth) throw new UploadError(`${label} is only ${size.width} px wide — use a full-size phone screenshot.`);
  const ratio = size.height / size.width;
  if (ratio < UPLOAD.minRatio || ratio > UPLOAD.maxRatio) throw new UploadError(`${label} isn't a portrait phone screenshot (${size.width}×${size.height}).`);
  return { kind, ...size };
}

/** Re-encodes one checked image to a clean PNG (no metadata). The input format is forced; only the local file is read. */
export function reencode(input: string, kind: "png" | "jpeg", out: string): void {
  const r = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file", "-f", kind === "png" ? "png_pipe" : "jpeg_pipe", "-i", input, "-map_metadata", "-1", "-frames:v", "1", "-pix_fmt", "rgb24", "-c:v", "png", "-f", "image2", "-y", out], { timeout: 30_000 });
  if (r.status !== 0 || !existsSync(out)) throw new UploadError("day2 couldn't read that image — save it again as PNG or JPEG.");
  const b = readFileSync(out);
  if (sniffImage(b) !== "png") throw new UploadError("day2 couldn't read that image.");
}

export const uploadsDir = (appId: string) => join(dataDir(), "creative-uploads", appId.replace(/[^\w-]/g, "_"));
const LANG = /^[a-z]{2}$/;

export function loadUploadSet(appId: string, locale: string): CaptureSet | null {
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) return null;
  const dir = join(uploadsDir(appId), locale);
  const p = join(dir, "set.json");
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf-8")) as CaptureSet;
    s.screens = s.screens.map((x) => ({ ...x, file: resolve(dir, x.file) })).filter((x) => x.file.startsWith(`${dir}/`) && existsSync(x.file));
    s.recordings = [];
    return s.screens.length ? s : null;
  } catch {
    return null;
  }
}

/** Every language the owner uploaded screens for. */
export function uploadLocales(appId: string): string[] {
  const d = uploadsDir(appId);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((x) => /^[a-z]{2}-[A-Z]{2}$/.test(x) && existsSync(join(d, x, "set.json"))).sort();
}

/** A screenshot file of an upload set, only from its own folder. */
export function uploadFile(appId: string, locale: string, name: string): string | null {
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale) || !/^\d{2}-upload\.png$/.test(name)) return null;
  const p = join(uploadsDir(appId), locale, name);
  return existsSync(p) ? p : null;
}

export function removeUploadSet(appId: string, locale: string): void {
  if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) throw new UploadError("Unknown language.");
  rmSync(join(uploadsDir(appId), locale), { recursive: true, force: true });
}

/**
 * Checks, cleans and stores a set (replacing the language's earlier set).
 * Nothing is kept when any file fails.
 */
export function saveUploadSet(appId: string, language: string, files: Array<{ name: string; bytes: Uint8Array }>, o: { now?: Date; version?: string | null; by?: string | null; encode?: typeof reencode } = {}): CaptureSet {
  if (!LANG.test(language)) throw new UploadError("Pick the language the screenshots are in.");
  if (files.length < UPLOAD.minFiles || files.length > UPLOAD.maxFiles) throw new UploadError(`Upload ${UPLOAD.minFiles}–${UPLOAD.maxFiles} screenshots (you sent ${files.length}).`);
  const total = files.reduce((n, f) => n + f.bytes.byteLength, 0);
  if (total > UPLOAD.maxTotal) throw new UploadError(`Together the screenshots are over ${UPLOAD.maxTotal / 1024 / 1024} MB.`, 413);
  const checked = files.map((f) => ({ ...f, ...checkScreenshot(f.name, f.bytes) }));
  const locale = localeFor(language);
  const work = mkdtempSync(join(tmpdir(), "day2-upload-"));
  const encode = o.encode ?? reencode;
  try {
    const screens: CaptureSet["screens"] = [];
    for (const [k, f] of checked.entries()) {
      const inFile = join(work, `in-${k}.${f.kind === "png" ? "png" : "jpg"}`);
      writeFileSync(inFile, f.bytes);
      const name = `${String(k + 1).padStart(2, "0")}-upload.png`;
      encode(inFile, f.kind, join(work, name));
      const size = headerSize(join(work, name)) ?? { width: f.width, height: f.height };
      screens.push({ file: name, ...size, language, source: "upload", name: `upload-${k + 1}`, statusBar: 0.055 });
    }
    const dir = join(uploadsDir(appId), locale);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const s of screens) renameSync(join(work, s.file), join(dir, s.file));
    const set: CaptureSet = { version: o.version ?? null, locale, language, capturedAt: (o.now ?? new Date()).toISOString(), source: "upload", device: null, screens, recordings: [], aiContent: null, mode: null };
    writeFileSync(join(dir, "set.json"), JSON.stringify({ ...set, by: o.by ?? null }, null, 2));
    return { ...set, screens: screens.map((s) => ({ ...s, file: join(dir, s.file) })) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
