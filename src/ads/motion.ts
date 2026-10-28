import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Browser } from "playwright";
import { dataUri, ENCODE, esc, PHONE, screenshotPage, SIZE, textOn, withBrowser, type Brand } from "./content";
import type { CopyVariant } from "./copy";
import type { Ratio } from "./types";

/**
 * "Motion" video ads, made in-house: kinetic text, the app's REAL
 * screenshots moving on a phone, benefit lines and an end card with the
 * call to action. No vendor and no generated UI — every screen is a real
 * screenshot of the app, every word comes from copy that already passed
 * day2's checks.
 *
 * A template is a pure function returning HTML whose CSS animations all
 * run on one timeline (duration = the video's length, paused). Rendering
 * sets every animation's currentTime to the frame's time, screenshots it,
 * and pipes the frames to ffmpeg — so frame N is always the same picture.
 */

export type MotionTemplate = "hook-reveal" | "screens-carousel" | "split-benefits";

export const MOTION_TEMPLATES: Array<{ id: MotionTemplate; label: string; bestFor: Ratio[] }> = [
  { id: "hook-reveal", label: "Kinetic headline, then the app on a phone", bestFor: ["9:16", "4:5", "2:3", "1:1", "16:9", "1.91:1"] },
  { id: "screens-carousel", label: "Phones side by side, swiping through screens", bestFor: ["9:16", "4:5", "2:3", "1:1", "16:9"] },
  { id: "split-benefits", label: "Phone on one side, benefits on the other", bestFor: ["1:1", "16:9", "1.91:1", "4:5"] },
];

/** The template for a ratio and copy variant: variants rotate through the templates that suit the ratio. */
export function pickTemplate(ratio: Ratio, variantIndex: number): MotionTemplate {
  const fits = MOTION_TEMPLATES.filter((t) => t.bestFor.includes(ratio)).map((t) => t.id);
  const order: MotionTemplate[] = SIZE[ratio].w / SIZE[ratio].h >= 1 ? ["split-benefits", "hook-reveal", "screens-carousel"] : ["hook-reveal", "screens-carousel", "split-benefits"];
  const list = order.filter((t) => fits.includes(t));
  return list[((variantIndex % list.length) + list.length) % list.length]!;
}

/** The words a motion ad uses — all from a checked copy variant. */
export type MotionCopy = Pick<CopyVariant, "frameHeadline" | "frameCta"> & Partial<Pick<CopyVariant, "headline" | "shortHeadline" | "body" | "description">>;

/** Short benefit lines from the variant's body and description (its own sentences, never new words). */
export function benefitLines(c: MotionCopy, max = 3): string[] {
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const seen = new Set([key(c.frameHeadline)]);
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim().replace(/\s+/g, " ").replace(/[.;:,]+$/, "");
    if (t.length < 12 || t.length > 110 || seen.has(key(t))) return;
    seen.add(key(t));
    out.push(t);
  };
  for (const text of [c.body, c.description]) for (const s of (text ?? "").split(/(?<=[.!?])\s+|\s+[—–]\s+|\n+/)) add(s);
  if (!out.length) for (const s of [c.headline, c.shortHeadline]) if (s) add(s);
  return out.slice(0, max);
}

// ---------------------------------------------------------------- screens

/**
 * 1–4 real phone screenshots of the app: the landing page, then the given
 * same-origin pages; when that's fewer than two, the landing page scrolled
 * down one screen (if it's long enough). Only loads and scrolls — never
 * taps, types or submits.
 */
export async function captureScreens(pageUrl: string, dir: string, opts: { screens?: string[]; landingShot?: string; browser?: Browser } = {}): Promise<string[]> {
  const origin = new URL(pageUrl).origin;
  const urls = [...new Set((opts.screens ?? []).filter((u) => {
    try {
      return new URL(u, pageUrl).origin === origin;
    } catch {
      return false;
    }
  }).map((u) => new URL(u, pageUrl).href))].filter((u) => u !== new URL(pageUrl).href).slice(0, 3);
  return withBrowser(async (b) => {
    const shots = [opts.landingShot ?? (await screenshotPage(pageUrl, join(dir, "motion-screen-0.png"), b))];
    for (const [k, u] of urls.entries()) {
      try {
        shots.push(await screenshotPage(u, join(dir, `motion-screen-${k + 1}.png`), b));
      } catch {
        // A page that doesn't load is left out.
      }
    }
    if (shots.length < 2) {
      const scrolled = await screenshotScrolled(pageUrl, join(dir, "motion-screen-scrolled.png"), b).catch(() => null);
      if (scrolled) shots.push(scrolled);
    }
    return shots;
  }, opts.browser);
}

/** The page scrolled down about one screen; null when it isn't long enough to be a different view. */
async function screenshotScrolled(url: string, out: string, b: Browser): Promise<string | null> {
  const ctx = await b.newContext({ ...PHONE, deviceScaleFactor: 3 });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(1500);
    const moved = await page.evaluate(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max < window.innerHeight * 0.6) return false;
      window.scrollTo(0, Math.min(max, Math.round(window.innerHeight * 0.85)));
      return true;
    });
    if (!moved) return null;
    await page.waitForTimeout(400);
    await page.screenshot({ path: out });
    return out;
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------- timeline

const OUT = "cubic-bezier(.22,1,.36,1)";
const INOUT = "cubic-bezier(.65,0,.35,1)";

/** Keyframe tracks on one shared timeline of `T` seconds. */
class Timeline {
  private rules: string[] = [];
  private n = 0;
  constructor(readonly T: number) {}
  /** Stops are [time s, css, easing into this stop]. Returns the class to put on the element. */
  track(stops: Array<[number, string, string?]>): string {
    const id = `k${this.n++}`;
    const pts = stops.map(([t, css, e]) => ({ p: Math.min(100, Math.max(0, (t / this.T) * 100)), css, e }));
    for (let i = 1; i < pts.length; i++) if (pts[i]!.p <= pts[i - 1]!.p) pts[i]!.p = Math.min(100, pts[i - 1]!.p + 0.01);
    const frames: string[] = [];
    if (pts[0]!.p > 0) frames.push(`0%{${pts[0]!.css}}`);
    pts.forEach((x, i) => {
      const next = pts[i + 1];
      if (i > 0 && x.p === pts[i - 1]!.p) return;
      frames.push(`${+x.p.toFixed(3)}%{${x.css}${next?.e ? `;animation-timing-function:${next.e}` : ""}}`);
    });
    if (pts[pts.length - 1]!.p < 100) frames.push(`100%{${pts[pts.length - 1]!.css}}`);
    this.rules.push(`@keyframes ${id}{${frames.join("")}}.${id}{animation:${id} ${this.T}s linear 0s 1 normal both paused}`);
    return id;
  }
  css() {
    return this.rules.join("\n");
  }
}

const st = (o: number, x = 0, y = 0, s = 1) => `opacity:${o};transform:translate3d(${r1(x)}px,${r1(y)}px,0) scale(${+s.toFixed(4)})`;
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- layout

type Box = { x: number; y: number; w: number; h: number };
const cx = (b: Box) => b.x + b.w / 2;
const cy = (b: Box) => b.y + b.h / 2;

/** Where text may go: away from platform UI (TikTok/Reels on 9:16: top bar, right-hand buttons, bottom caption). */
export function motionSafeArea(ratio: Ratio): Box {
  const { w, h } = SIZE[ratio];
  const [t, r, b, l] = ratio === "9:16" ? [0.085, 0.12, 0.22, 0.09] : w / h < 1 ? [0.06, 0.08, 0.07, 0.08] : [0.07, 0.065, 0.07, 0.065];
  return { x: Math.round(w * l), y: Math.round(h * t), w: Math.round(w * (1 - l - r)), h: Math.round(h * (1 - t - b)) };
}

/** A phone of screen height `sh`, as the outer box (with bezel). */
function phoneDims(sh: number) {
  const sw = Math.round((sh * 390) / 844);
  const bezel = Math.max(4, Math.round(sw * 0.035));
  return { sw, sh: Math.round(sh), bezel, radius: Math.round(sw * 0.12), ow: sw + 2 * bezel, oh: Math.round(sh) + 2 * bezel };
}

/** A font size (px) that fits `text` into `lines` lines of `width` px. */
function fit(text: string, width: number, lines: number, maxPx: number, minPx: number): number {
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => w.length));
  const size = Math.min(maxPx, (width * lines * 0.82) / (Math.max(1, text.length) * 0.56), width / (longest * 0.64));
  return Math.max(minPx, Math.floor(size));
}
const estLines = (text: string, width: number, px: number) => Math.max(1, Math.ceil((text.length * 0.56 * px) / (width * 0.9)));

// ---------------------------------------------------------------- templates

export type MotionInput = { ratio: Ratio; template: MotionTemplate; copy: MotionCopy; brand: Brand; screenshots: string[]; seconds?: number };

const safeColor = (c: string | undefined, d: string) => (c && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : d);
const safeFont = (f?: string) => (f ?? "").replace(/[<>{};\\]/g, "").trim();

/** The ad as HTML with every animation on one paused timeline. Pure: the same input always gives the same HTML. */
export function motionHtml(i: MotionInput): string {
  const { w: W, h: H } = SIZE[i.ratio];
  const T = Math.max(1, i.seconds ?? 12);
  const tl = new Timeline(T);
  const u = Math.min(1, T / 12); // short videos compress the small motions too
  const at = (f: number) => f * T; // phase boundaries, as a share of the video
  const s = Math.min(W, H) / 1080;
  const bg = safeColor(i.brand.colors[0], "#141414");
  const fg = textOn(bg);
  const accent = safeColor(i.brand.colors[1], fg);
  const font = `${safeFont(i.brand.font) ? `${safeFont(i.brand.font)}, ` : ""}Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  const logo = i.brand.logoPath ? dataUri(i.brand.logoPath) : null;
  const shots = (i.screenshots.length ? i.screenshots : [""]).slice(0, 4).map((p) => (p ? dataUri(p) ?? "" : ""));
  const safe = motionSafeArea(i.ratio);
  const wide = W / H >= 1;
  const head = i.copy.frameHeadline.trim();
  const benefits = benefitLines(i.copy, 3);
  const nScreens = shots.length;

  // Events: each swaps to the next screen and/or the next line of text.
  const lines = [head, ...benefits];
  const tpl = i.template;
  const eventCount = tpl === "split-benefits" ? Math.max(nScreens - 1, benefits.length) : Math.max(nScreens - 1, lines.length - 1);
  const winStart = at(tpl === "hook-reveal" ? 0.27 : 0.16);
  const endT = at(0.79);
  const events = Array.from({ length: eventCount }, (_, e) => winStart + ((e + 1) * (endT - winStart)) / (eventCount + 1) - 0.25 * u);
  const dSlide = 0.7 * u;
  const dFade = 0.55 * u;

  const words = (text: string, start: number, stagger = 0.075) =>
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((word, k) => {
        const t0 = start + k * stagger * u;
        const cls = tl.track([
          [t0, `opacity:0;transform:translateY(.32em);filter:blur(${r1(8 * s)}px)`],
          [t0 + 0.6 * u, "opacity:1;transform:translateY(0);filter:blur(0px)", OUT],
        ]);
        return `<span class="w ${cls}">${esc(word)}</span>`;
      })
      .join(" ");
  const wordsEnd = (text: string, start: number, stagger = 0.075) => start + (text.split(/\s+/).filter(Boolean).length - 1) * stagger * u + 0.6 * u;

  /** Fades in at `tIn` (rising by dy), out at `tOut` (rising further). */
  const fadeInOut = (tIn: number | null, tOut: number | null, dy = 24 * s) =>
    tl.track([
      ...(tIn === null ? ([[0, st(1)]] as Array<[number, string]>) : ([[tIn, st(0, 0, dy)], [tIn + dFade, st(1), OUT]] as Array<[number, string, string?]>)),
      ...(tOut === null ? [] : ([[tOut, st(1)], [tOut + dFade * 0.8, st(0, 0, -dy * 0.6), INOUT]] as Array<[number, string, string?]>)),
    ]);

  const phone = (d: ReturnType<typeof phoneDims>, screensHtml: string, extraCls = "", style = "") =>
    `<div class="phone ${extraCls}" style="width:${d.ow}px;height:${d.oh}px;border-radius:${d.radius + d.bezel}px;padding:${d.bezel}px;${style}"><div class="scr" style="width:${d.sw}px;height:${d.sh}px;border-radius:${d.radius}px">${screensHtml}</div></div>`;

  /** Screens on one phone: each slides in from the right at its event (iOS push). */
  const slidingScreens = (d: ReturnType<typeof phoneDims>) =>
    shots
      .map((src, k) => {
        const tIn = k === 0 ? null : events[k - 1]!;
        const tOut = k < nScreens - 1 ? events[k]! : null;
        const cls = tl.track([
          ...(tIn === null ? ([[0, st(1)]] as Array<[number, string, string?]>) : ([[tIn, st(1, d.sw)], [tIn + dSlide, st(1), INOUT]] as Array<[number, string, string?]>)),
          ...(tOut === null ? [] : ([[tOut, st(1)], [tOut + dSlide, st(1, -d.sw * 0.3), INOUT]] as Array<[number, string, string?]>)),
        ]);
        return `<img class="${cls}" style="z-index:${k + 1}" src="${src}" alt="">`;
      })
      .join("");
  /** Caption lines in one box: line 0 (already shown) is replaced by line k at event k-1. */
  const captions = (box: Box, px: number, from: number, align: "center" | "left" = "center") =>
    lines
      .slice(from)
      .map((text, j) => {
        const k = j + from;
        if (k >= lines.length || k - 1 >= events.length) return "";
        const tIn = events[k - 1]!;
        const tOut = k < lines.length - 1 && k < events.length ? events[k]! : null;
        const size = Math.min(px, fit(text, box.w, 3, px, Math.round(30 * s)));
        return `<div class="box cap ${fadeInOut(tIn + dFade * 0.8 + 0.05 * u, tOut)}" style="${boxCss(box)};align-items:${align === "center" ? "center" : "flex-start"};text-align:${align}"><div class="hl" style="font-size:${size}px;font-weight:650">${esc(text)}</div></div>`;
      })
      .join("");

  let main = "";

  if (tpl === "hook-reveal") {
    // 1) The headline, big, word by word. 2) It settles into the text band as the phone rises. 3) Screens + benefit lines.
    const d = wide ? phoneDims(H * (i.ratio === "1:1" ? 0.8 : 0.84)) : phoneDims(H * (i.ratio === "9:16" ? 0.6 : 0.62));
    const ph: Box = wide
      ? { x: W - safe.x - d.ow - Math.round(W * (i.ratio === "1:1" ? 0 : 0.04)), y: Math.round((H - d.oh) / 2), w: d.ow, h: d.oh }
      : { x: Math.round((W - d.ow) / 2), y: Math.round(H * (i.ratio === "9:16" ? 0.31 : 0.29)), w: d.ow, h: d.oh };
    const band: Box = wide
      ? { x: safe.x, y: safe.y, w: Math.min(ph.x - safe.x - Math.round(60 * s), Math.round(860 * s)), h: safe.h }
      : { x: safe.x, y: safe.y, w: safe.w, h: ph.y - safe.y - Math.round(30 * s) };
    if (wide) band.x = Math.round(safe.x + (ph.x - safe.x - Math.round(60 * s) - band.w) / 2);
    const intro: Box = { x: safe.x, y: safe.y, w: safe.w, h: safe.h };
    const introPx = fit(head, intro.w, 4, Math.round((wide ? 110 : 116) * s), Math.round(44 * s));
    const bandPx = fit(head, band.w, wide ? 5 : 3, Math.round((wide ? 76 : 80) * s), Math.round(34 * s));
    let k = Math.min(1, bandPx / introPx);
    const introLines = estLines(head, intro.w, introPx);
    k = Math.min(k, band.h / (introLines * introPx * 1.08 * 1.1));
    const tSettle = Math.max(wordsEnd(head, 0.25 * u) + 0.5 * u, at(0.17));
    const firstOut = events.length && lines.length > 1 ? events[0]! : null;
    // Tall: the headline moves and shrinks into the band (same width, so the same line breaks fit).
    // Side layouts: the column is narrower, so it crossfades to the headline set for the column.
    const headCls = wide
      ? tl.track([
          [tSettle, st(1)],
          [tSettle + 0.5 * u, st(0, 0, -20 * s, 0.97), INOUT],
        ])
      : tl.track([
          [tSettle, st(1)],
          [tSettle + 0.9 * u, st(1, cx(band) - cx(intro), cy(band) - cy(intro), k), INOUT],
          ...(firstOut !== null ? ([[firstOut, st(1, cx(band) - cx(intro), cy(band) - cy(intro), k)], [firstOut + dFade * 0.8, st(0, cx(band) - cx(intro), cy(band) - cy(intro) - 14 * s, k), INOUT]] as Array<[number, string, string?]>) : []),
        ]);
    const rise = tl.track([
      [tSettle + (wide ? 0.4 : 0.15) * u, st(0, wide ? W * 0.25 : 0, wide ? 0 : H * 0.35, 1)],
      [tSettle + (wide ? 1.4 : 1.15) * u, st(1), OUT],
      [endT, st(1, 0, -6 * s)],
    ]);
    main = `<div class="box ${headCls}" style="${boxCss(intro)}"><div class="hl" style="font-size:${introPx}px">${words(head, 0.25 * u)}</div></div>
${wide ? `<div class="box ${fadeInOut(tSettle + 0.5 * u, firstOut)}" style="${boxCss(band)}"><div class="hl" style="font-size:${bandPx}px">${esc(head)}</div></div>` : ""}
${captions(band, wide ? bandPx : Math.round(k * introPx), 1)}
<div class="${rise}" style="position:absolute;left:${ph.x}px;top:${ph.y}px">${phone(d, slidingScreens(d))}</div>`;
  } else if (tpl === "screens-carousel") {
    // Phones in a row, the current one in front; captions above change with each swipe.
    const bandTop = safe.y;
    const bandH = Math.round(H * (W / H < 0.7 ? 0.19 : 0.2));
    const band: Box = { x: safe.x, y: bandTop, w: safe.w, h: bandH };
    const phoneTop = bandTop + bandH + Math.round(H * 0.025);
    const d = phoneDims(H * (i.ratio === "9:16" ? 0.6 : 0.62));
    const step = d.ow + Math.round(56 * s);
    const px0 = Math.round((W - d.ow) / 2);
    const px = fit(head, band.w, 3, Math.round(76 * s), Math.round(32 * s));
    const rowStops: Array<[number, string, string?]> = [[0, st(1)]];
    events.forEach((t, e) => {
      if (e + 1 < nScreens) rowStops.push([t, st(1, -e * step)], [t + dSlide, st(1, -(e + 1) * step), INOUT]);
    });
    const row = tl.track(rowStops);
    const rise = tl.track([
      [0.45 * u, st(0, 0, 90 * s)],
      [1.45 * u, st(1), OUT],
    ]);
    const phones = shots
      .map((src, k) => {
        const on = st(1, 0, 0, 1);
        const off = st(0.5, 0, 0, 0.86);
        const stops: Array<[number, string, string?]> = [[0, k === 0 ? on : off]];
        if (k > 0 && events[k - 1] !== undefined) stops.push([events[k - 1]!, off], [events[k - 1]! + dSlide, on, INOUT]);
        if (k < nScreens - 1 && events[k] !== undefined) stops.push([events[k]!, on], [events[k]! + dSlide, off, INOUT]);
        return phone(d, `<img src="${src}" alt="">`, tl.track(stops), `position:absolute;left:${px0 + k * step}px;top:0`);
      })
      .join("");
    main = `<div class="box ${fadeInOut(null, events[0] !== undefined && lines.length > 1 ? events[0] : null)}" style="${boxCss(band)}"><div class="hl" style="font-size:${px}px">${words(head, 0.2 * u)}</div></div>
${captions(band, px, 1)}
<div class="${rise}" style="position:absolute;left:0;top:${phoneTop}px;width:${W}px;height:${d.oh}px"><div class="${row}" style="position:absolute;inset:0">${phones}</div></div>`;
  } else {
    // split-benefits: phone on one side, headline and up to three benefits appearing on the other.
    const d = wide ? phoneDims(H * (i.ratio === "1:1" ? 0.8 : 0.84)) : phoneDims(H * (i.ratio === "9:16" ? 0.53 : 0.52));
    const ph: Box = wide
      ? { x: W - safe.x - d.ow - Math.round(W * (i.ratio === "1:1" ? 0 : 0.04)), y: Math.round((H - d.oh) / 2), w: d.ow, h: d.oh }
      : { x: Math.round((W - d.ow) / 2), y: Math.round(H * (i.ratio === "9:16" ? 0.42 : 0.44)), w: d.ow, h: d.oh };
    const col: Box = wide
      ? { x: safe.x, y: safe.y, w: Math.min(ph.x - safe.x - Math.round(70 * s), Math.round(900 * s)), h: safe.h }
      : { x: safe.x, y: safe.y, w: safe.w, h: ph.y - safe.y - Math.round(30 * s) };
    if (wide) col.x = Math.max(safe.x, Math.round(safe.x + (ph.x - safe.x - Math.round(70 * s) - col.w) / 2));
    const n = benefits.length;
    const hPx = fit(head, col.w, n ? 3 : 4, Math.round((wide ? 72 : i.ratio === "9:16" ? 92 : 80) * s * (n > 2 && !wide ? 0.9 : 1)), Math.round(32 * s));
    const bPx = Math.min(Math.round(hPx * 0.52), ...benefits.map((b) => fit(b, col.w - Math.round(64 * s), 2, Math.round((wide ? 40 : 44) * s), Math.round(22 * s))));
    const slide = tl.track([
      [0.55 * u, st(0, wide ? 80 * s : 0, wide ? 0 : 120 * s)],
      [1.6 * u, st(1), OUT],
      [endT, st(1, 0, -6 * s)],
    ]);
    const items = benefits
      .map((b, e) => {
        const t = events[e] ?? at(0.3 + e * 0.12);
        const cls = tl.track([
          [t, st(0, -16 * s, 0)],
          [t + dFade, st(1), OUT],
        ]);
        return `<div class="li ${cls}" style="font-size:${bPx}px;gap:${Math.round(bPx * 0.6)}px"><span class="tick" style="width:${Math.round(bPx * 1.25)}px;height:${Math.round(bPx * 1.25)}px"><svg viewBox="0 0 24 24" width="62%" height="62%"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="${bg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>${esc(b)}</span></div>`;
      })
      .join("");
    main = `<div class="box" style="${boxCss(col)};align-items:flex-start;text-align:left;gap:${Math.round(hPx * 0.55)}px">
<div class="hl" style="font-size:${hPx}px;text-wrap:balance">${words(head, 0.2 * u)}</div>
${items ? `<div class="list" style="gap:${Math.round(bPx * 0.75)}px">${items}</div>` : ""}
</div>
<div class="${slide}" style="position:absolute;left:${ph.x}px;top:${ph.y}px">${phone(d, slidingScreens(d))}</div>`;
  }

  // End card: everything else fades out; mark, app name, headline, button.
  const mainOut = tl.track([
    [endT, "opacity:1;transform:scale(1)"],
    [endT + 0.6 * u, "opacity:0;transform:scale(.97)", INOUT],
  ]);
  const card: Box = { x: safe.x, y: safe.y, w: safe.w, h: wide ? safe.h : Math.round(safe.h * (i.ratio === "9:16" ? 0.92 : 1)) };
  const cardHeadPx = fit(head, Math.min(card.w, Math.round(900 * s)), 3, Math.round(wide ? 72 * s : 88 * s), Math.round(30 * s));
  const tCard = endT + 0.35 * u;
  const appear = (k: number) => fadeInOut(tCard + k * 0.12 * u, null, 20 * s);
  const markPx = Math.round((wide ? 112 : 136) * s);
  const mark = logo
    ? `<img class="${appear(0)}" src="${logo}" alt="" style="height:${markPx}px;width:auto;border-radius:${Math.round(markPx * 0.24)}px">`
    : `<div class="mark ${appear(0)}" style="width:${markPx}px;height:${markPx}px;border-radius:${Math.round(markPx * 0.26)}px;font-size:${Math.round(markPx * 0.5)}px">${esc((i.brand.name.trim()[0] ?? "").toUpperCase())}</div>`;
  const endCard = `<div class="box" style="${boxCss(card)};gap:${Math.round(30 * s)}px">
${mark}
<div class="name ${appear(1)}" style="font-size:${Math.round((wide ? 34 : 40) * s)}px">${esc(i.brand.name)}</div>
<div class="hl ${appear(2)}" style="font-size:${cardHeadPx}px;max-width:${Math.round(900 * s)}px;margin-top:${Math.round(6 * s)}px">${esc(head)}</div>
<div class="cta ${appear(3)}" style="font-size:${Math.round((wide ? 36 : 42) * s)}px;padding:${Math.round((wide ? 24 : 28) * s)}px ${Math.round((wide ? 52 : 60) * s)}px;margin-top:${Math.round(14 * s)}px">${esc(i.copy.frameCta)}</div>
</div>`;

  const glow = tl.track([
    [0, `transform:translate3d(${r1(-W * 0.06)}px,${r1(-H * 0.04)}px,0)`],
    [T, `transform:translate3d(${r1(W * 0.06)}px,${r1(H * 0.05)}px,0)`],
  ]);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${bg}}
body{font-family:${font};color:${fg};position:relative;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.glow{position:absolute;left:${r1(-W * 0.35)}px;top:${r1(-H * 0.35)}px;width:${r1(W * 1.1)}px;height:${r1(H * 0.9)}px;background:radial-gradient(closest-side, ${accent}30, ${accent}00);pointer-events:none}
.layer{position:absolute;inset:0}
.box{position:absolute;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}
.hl{font-weight:700;letter-spacing:-.025em;line-height:1.08;text-wrap:balance}
.w{display:inline-block;will-change:transform,opacity,filter}
.phone{background:#0b0b0c;box-shadow:0 ${r1(28 * s)}px ${r1(70 * s)}px rgba(0,0,0,.28),0 ${r1(4 * s)}px ${r1(14 * s)}px rgba(0,0,0,.18),inset 0 0 0 ${r1(Math.max(1, 1.5 * s))}px rgba(255,255,255,.08)}
.scr{position:relative;overflow:hidden;background:#fff;isolation:isolate;transform:translateZ(0)}
.scr img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;object-position:top;box-shadow:-${r1(10 * s)}px 0 ${r1(30 * s)}px rgba(0,0,0,.14)}
.list{display:flex;flex-direction:column;align-items:flex-start}
.li{display:flex;align-items:center;font-weight:550;line-height:1.25;letter-spacing:-.01em;opacity:.95}
.li>span:last-child{text-wrap:balance}
.tick{flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:${fg}}
.mark{display:flex;align-items:center;justify-content:center;background:${fg};color:${bg};font-weight:750}
.name{font-weight:600;opacity:.75;letter-spacing:-.01em}
.cta{display:inline-block;border-radius:999px;background:${fg};color:${bg};font-weight:650;letter-spacing:-.01em}
${tl.css()}
</style></head><body>
<div class="glow ${glow}"></div>
<div class="layer ${mainOut}">
${main}
</div>
${endCard}
</body></html>`;
}

function boxCss(b: Box) {
  return `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
}

// ---------------------------------------------------------------- render

type Page = Awaited<ReturnType<Browser["newPage"]>>;

async function openMotion(b: Browser, i: MotionInput): Promise<Page> {
  const { w, h } = SIZE[i.ratio];
  const page = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  // No network: the page is self-contained (screens are data URIs).
  await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
  await page.setContent(motionHtml(i), { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((im) => im.decode().catch(() => {})));
    for (const a of document.getAnimations()) a.pause();
  });
  return page;
}

async function seek(page: Page, t: number) {
  await page.evaluate((ms: number) => {
    // The screenshot that follows renders a fresh frame: no need to wait for one.
    for (const a of document.getAnimations()) a.currentTime = ms;
  }, Math.round(t * 1000));
}

/** One frame of a motion ad at `t` seconds, as an image (JPEG if `out` ends in .jpg, else PNG). */
export async function renderMotionStill(i: MotionInput & { t: number; out: string; browser?: Browser }): Promise<string> {
  return withBrowser(async (b) => {
    const page = await openMotion(b, i);
    try {
      await seek(page, i.t);
      const jpg = /\.jpe?g$/i.test(i.out);
      await page.screenshot({ path: i.out, type: jpg ? "jpeg" : "png", ...(jpg ? { quality: 90 } : {}), animations: "allow", caret: "initial" });
      return i.out;
    } finally {
      await page.close();
    }
  }, i.browser);
}

/**
 * The motion ad as an MP4 (H.264 yuv420p, 30 fps, silent AAC track, faststart),
 * at the ratio's exact size. Frames are rendered at `fps` (default 30).
 */
export async function renderMotionAd(i: MotionInput & { out: string; fps?: number; browser?: Browser }): Promise<string> {
  const seconds = Math.max(1, i.seconds ?? 12);
  const fps = Math.max(1, Math.min(60, Math.round(i.fps ?? 30)));
  const frames = Math.round(seconds * fps);
  return withBrowser(async (b) => {
    const page = await openMotion(b, { ...i, seconds });
    const ff = spawn(
      process.env.FFMPEG_PATH ?? "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-map", "0:v", "-map", "1:a",
        "-vf", "scale=in_range=full:out_range=tv,format=yuv420p,setsar=1",
        "-t", String(seconds),
        ...ENCODE,
        i.out,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let err = "";
    ff.stderr.on("data", (d) => (err += String(d)));
    const done = new Promise<void>((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`))));
    });
    done.catch(() => {});
    // Straight to the DevTools protocol: much faster than page.screenshot per frame.
    const cdp = await page.context().newCDPSession(page);
    try {
      for (let f = 0; f < frames; f++) {
        await seek(page, f / fps);
        const { data } = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92, optimizeForSpeed: true } as never)) as { data: string };
        const jpg = Buffer.from(data, "base64");
        if (ff.exitCode !== null) break;
        if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
      }
    } finally {
      ff.stdin.end();
      await page.close().catch(() => {});
    }
    await done;
    return i.out;
  }, i.browser);
}
