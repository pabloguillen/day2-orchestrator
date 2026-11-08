import { mix, onColor, type ResolvedKit } from "../brand-kit";
import { bodyStack, color, displayStack, EASE, esc, fileUri, r1, tf, type Timeline } from "../motion/engine";
import type { Point, Region, ScreenAsset } from "./types";

/**
 * The shared design vocabulary of every template: type scale, chips, the
 * app's screen as a card, its 3D stickers, the dotted trail, captions, the
 * end card with the real icon. All colours, fonts and radii come from the
 * brand kit; all text is escaped.
 */

/** Small UI words per language (the rest of the text comes from the shot list). */
const LABELS: Record<string, { step: string; before: string; after: string; isNew: string; swipe: string; howItWorks: string; linkInBio: string; version: string }> = {
  de: { step: "Schritt", before: "Vorher", after: "Nachher", isNew: "Neu", swipe: "Wisch", howItWorks: "So geht's", linkInBio: "Link in Bio", version: "Version" },
  en: { step: "Step", before: "Before", after: "After", isNew: "New", swipe: "Swipe", howItWorks: "How it works", linkInBio: "Link in bio", version: "Version" },
  fr: { step: "Étape", before: "Avant", after: "Après", isNew: "Nouveau", swipe: "Glisse", howItWorks: "Comment ça marche", linkInBio: "Lien en bio", version: "Version" },
  es: { step: "Paso", before: "Antes", after: "Después", isNew: "Nuevo", swipe: "Desliza", howItWorks: "Así funciona", linkInBio: "Link en la bio", version: "Versión" },
  it: { step: "Passo", before: "Prima", after: "Dopo", isNew: "Novità", swipe: "Scorri", howItWorks: "Come funziona", linkInBio: "Link in bio", version: "Versione" },
  nl: { step: "Stap", before: "Voor", after: "Na", isNew: "Nieuw", swipe: "Swipe", howItWorks: "Zo werkt het", linkInBio: "Link in bio", version: "Versie" },
};
export const labels = (lang: string) => LABELS[lang] ?? LABELS.en!;

/** Where text may go on 9:16: clear of TikTok/Reels UI (top bar, right-hand buttons, caption and username at the bottom). */
export const SAFE_916 = { top: 230, bottom: 1500, left: 84, right: 930 } as const;
/** Feed posts and carousels: a calm margin. */
export const safeFor = (W: number, H: number) => (H / W > 1.6 ? SAFE_916 : { top: Math.round(H * 0.075), bottom: Math.round(H * 0.93), left: 84, right: W - 84 });

export type Colors = { primary: string; onPrimary: string; ink: string; inkSoft: string; bg: string; surface: string; primarySoft: string; primaryDeep: string; accent: string };
export function colors(k: ResolvedKit): Colors {
  const primary = color(k.primary, "#141414");
  const ink = color(k.ink, "#111111");
  const bg = color(k.background, "#ffffff");
  return {
    primary,
    onPrimary: onColor(primary, ink),
    ink,
    inkSoft: color(k.inkSoft, mix(ink, bg, 0.45)),
    bg,
    surface: color(k.surface, mix(bg, ink, 0.05)),
    primarySoft: mix(primary, "#ffffff", 0.55),
    primaryDeep: mix(primary, "#000000", 0.14),
    accent: color(k.accent, ink),
  };
}

export function baseCss(k: ResolvedKit, c: Colors): string {
  const display = displayStack(k);
  const body = bodyStack(k);
  return `
.display{font-family:${display};font-weight:${Math.max(800, k.displayFont.weight)};letter-spacing:-.025em;line-height:.98}
.body{font-family:${body};font-weight:${k.bodyFont.weight};letter-spacing:-.005em;line-height:1.2}
.chip{display:inline-flex;align-items:center;gap:.4em;font-family:${display};font-weight:800;border-radius:999px;padding:.42em .9em .46em;letter-spacing:-.01em;white-space:nowrap}
.card{position:absolute;overflow:hidden;background:#fff;box-shadow:0 40px 90px rgba(0,0,0,.20),0 8px 22px rgba(0,0,0,.10),0 0 0 2px rgba(0,0,0,.05)}
img.scr{position:absolute;left:0;width:100%;height:auto}
.sticker{position:absolute;filter:drop-shadow(0 18px 24px rgba(0,0,0,.18))}
.dot{position:absolute;border-radius:50%}
.btn{display:inline-flex;align-items:center;justify-content:center;font-family:${display};font-weight:850;border-radius:999px;white-space:nowrap;letter-spacing:-.01em}
.btn3d{background:linear-gradient(180deg,#4a4a4a,#262626 55%,#161616);color:#fff;box-shadow:0 .16em 0 #0b0b0b,0 .5em .9em rgba(0,0,0,.22),inset 0 .06em 0 rgba(255,255,255,.25)}
.btnflat{background:${c.ink};color:${onColor(c.ink)}}
.icon{position:absolute;box-shadow:0 30px 60px rgba(0,0,0,.22),0 0 0 2px rgba(0,0,0,.04)}
.cap{position:absolute;display:flex;justify-content:center;left:0;right:0}
.capbox{font-family:${display};font-weight:850;background:#fff;color:${c.ink};border-radius:28px;padding:18px 28px 20px;box-shadow:0 18px 40px rgba(0,0,0,.18);text-align:center;line-height:1.18;max-width:800px}
.capw{display:inline-block;border-radius:12px;padding:0 .12em;margin:0 -.02em}
`;
}

/** Words as spans (for word-by-word animation and fitting). */
export const wordSpans = (text: string, cls = "w", extra?: (k: number) => string) =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, k) => `<span class="${cls}${extra ? ` ${extra(k)}` : ""}">${esc(w)}</span>`)
    .join(" ");

/** The screen's crop: hide the status bar in cards (clean frames), keep the rest from the top. Pure. */
export function screenGeom(s: Pick<ScreenAsset, "width" | "height" | "statusBar">, cardW: number) {
  const scale = cardW / Math.max(1, s.width);
  const fullH = s.height * scale;
  const crop = Math.round(fullH * (s.statusBar ?? 0));
  return { scale, fullH, crop, visibleH: fullH - crop };
}

/** A point on the screen (shares) → px inside the card (after the status bar crop). */
export const onCard = (p: Point, s: Pick<ScreenAsset, "width" | "height" | "statusBar">, cardW: number) => {
  const g = screenGeom(s, cardW);
  return { x: p.x * cardW, y: p.y * g.fullH - g.crop };
};
export const regionCenter = (r: Region): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function screenImg(s: ScreenAsset, cardW: number, cls = "", style = ""): string {
  const g = screenGeom(s, cardW);
  return `<img class="scr ${cls}" src="${fileUri(s.file) ?? ""}" style="top:${-g.crop}px;${style}" alt="">`;
}

export function cardHtml(o: { s: ScreenAsset; x: number; y: number; w: number; h: number; radius: number; cls?: string; inner?: string; style?: string }): string {
  return `<div class="card ${o.cls ?? ""}" style="left:${r1(o.x)}px;top:${r1(o.y)}px;width:${r1(o.w)}px;height:${r1(o.h)}px;border-radius:${o.radius}px;${o.style ?? ""}">${screenImg(o.s, o.w)}${o.inner ?? ""}</div>`;
}

/**
 * Zoom-to-detail on slides: the region that matters, lifted off the screen
 * and enlarged (the App Store "pop-out"), centred over where it sits.
 * Returns the html and its box.
 */
export function popoutHtml(o: { s: ScreenAsset; focus: Region; cardX: number; cardY: number; cardW: number; maxW: number; minX: number; maxX: number; minY: number; maxY: number; ring: string; radius: number; zoom?: number }): { html: string; box: { x: number; y: number; w: number; h: number } } {
  const g = screenGeom(o.s, o.cardW);
  const rw = o.focus.w * o.cardW;
  const rh = o.focus.h * g.fullH;
  const z = Math.max(1.15, Math.min(o.zoom ?? 1.9, o.maxW / rw));
  const w = rw * z;
  const h = rh * z;
  const cx = o.cardX + (o.focus.x + o.focus.w / 2) * o.cardW;
  const cy = o.cardY + (o.focus.y + o.focus.h / 2) * g.fullH - g.crop;
  const x = Math.max(o.minX, Math.min(o.maxX - w, cx - w / 2));
  const y = Math.max(o.minY, Math.min(o.maxY - h, cy - h / 2));
  const imgW = o.cardW * z;
  const html = `<div class="abs" style="left:${r1(x)}px;top:${r1(y)}px;width:${r1(w)}px;height:${r1(h)}px;border-radius:${o.radius}px;overflow:hidden;background:#fff;box-shadow:0 0 0 6px ${o.ring},0 34px 70px rgba(0,0,0,.28),0 8px 18px rgba(0,0,0,.12)"><img src="${fileUri(o.s.file) ?? ""}" style="position:absolute;width:${r1(imgW)}px;height:auto;left:${r1(-o.focus.x * imgW)}px;top:${r1(-o.focus.y * g.fullH * z)}px" alt=""></div>`;
  return { html, box: { x, y, w, h } };
}

/** A magnified circle of the screen (slides' zoom-to-detail). */
export function loupeHtml(o: { s: ScreenAsset; focus: Region; x: number; y: number; d: number; zoom: number; cardW: number; ring: string }): string {
  const g = screenGeom(o.s, o.cardW);
  const imgW = o.cardW * o.zoom;
  const c = regionCenter(o.focus);
  const fx = c.x * imgW;
  const fy = c.y * g.fullH * o.zoom;
  return `<div class="abs" style="left:${r1(o.x - o.d / 2)}px;top:${r1(o.y - o.d / 2)}px;width:${o.d}px;height:${o.d}px;border-radius:50%;overflow:hidden;background:#fff;box-shadow:0 0 0 ${Math.round(o.d * 0.035)}px ${o.ring},0 30px 60px rgba(0,0,0,.25)"><img src="${fileUri(o.s.file) ?? ""}" style="position:absolute;width:${r1(imgW)}px;height:auto;left:${r1(o.d / 2 - fx)}px;top:${r1(o.d / 2 - fy)}px" alt=""></div>`;
}

/** One of the app's own stickers, or "" when the app has none of that name. */
export function stickerHtml(k: ResolvedKit, name: string | null | undefined, o: { x: number; y: number; size: number; rot?: number; cls?: string }): string {
  const file = name ? k.stickers[name] : null;
  const uri = fileUri(file);
  if (!uri) return "";
  return `<img class="sticker ${o.cls ?? ""}" src="${uri}" style="left:${r1(o.x - o.size / 2)}px;top:${r1(o.y - o.size / 2)}px;width:${o.size}px;height:${o.size}px;transform:rotate(${o.rot ?? 0}deg)" alt="">`;
}
/** A sticker the kit has, from preferences (first that exists). */
export const pickSticker = (k: ResolvedKit, ...names: Array<string | null | undefined>) => names.find((n) => n && k.stickers[n]) ?? null;

/** The real app icon (squircle), or "" — never a placeholder letter. */
export function iconHtml(k: ResolvedKit, o: { x: number; y: number; size: number; cls?: string; style?: string }): string {
  const uri = fileUri(k.icon);
  if (!uri) return "";
  return `<img class="icon ${o.cls ?? ""}" src="${uri}" style="left:${r1(o.x - o.size / 2)}px;top:${r1(o.y - o.size / 2)}px;width:${o.size}px;height:${o.size}px;border-radius:${Math.round(o.size * 0.2237)}px;${o.style ?? ""}" alt="">`;
}

export function buttonHtml(k: ResolvedKit, text: string, px: number, cls = "", style = ""): string {
  return `<span class="btn ${k.illustration === "3d-icons" ? "btn3d" : "btnflat"} ${cls}" data-text="cta" style="font-size:${px}px;padding:.62em 1.25em .7em;${style}">${esc(text)}</span>`;
}

/** Points along a smooth path (Catmull-Rom through `via`), `n` evenly spaced. Pure. */
export function trailPoints(via: Point[], n: number): Point[] {
  if (via.length < 2) return via.slice();
  const seg = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
    const t2 = t * t;
    const t3 = t2 * t;
    const f = (a: number, b: number, c2: number, d: number) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3);
    return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
  };
  const dense: Point[] = [];
  for (let i = 0; i < via.length - 1; i++) {
    const p0 = via[Math.max(0, i - 1)]!;
    const p3 = via[Math.min(via.length - 1, i + 2)]!;
    for (let s = 0; s < 40; s++) dense.push(seg(p0, via[i]!, via[i + 1]!, p3, s / 40));
  }
  dense.push(via[via.length - 1]!);
  const len: number[] = [0];
  for (let i = 1; i < dense.length; i++) len.push(len[i - 1]! + Math.hypot(dense[i]!.x - dense[i - 1]!.x, dense[i]!.y - dense[i - 1]!.y));
  const total = len[len.length - 1]!;
  const out: Point[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const want = (total * k) / Math.max(1, n - 1);
    while (j < len.length - 2 && len[j + 1]! < want) j++;
    const span = len[j + 1]! - len[j]! || 1;
    const t = (want - len[j]!) / span;
    out.push({ x: dense[j]!.x + (dense[j + 1]!.x - dense[j]!.x) * t, y: dense[j]!.y + (dense[j + 1]!.y - dense[j]!.y) * t });
  }
  return out;
}

/** The dotted trail (the brand's dots), optionally appearing dot by dot between t0 and t1. */
export function trailHtml(pts: Point[], o: { r: number; color: string; tl?: Timeline; t0?: number; t1?: number; growLast?: number }): string {
  return pts
    .map((p, i) => {
      const last = i === pts.length - 1 && o.growLast;
      const r = last ? o.r * o.growLast! : o.r;
      const cls = o.tl && o.t0 !== undefined && o.t1 !== undefined ? o.tl.track([[o.t0 + ((o.t1 - o.t0) * i) / Math.max(1, pts.length - 1), tf(0, 0, 0, 0.2)], [o.t0 + ((o.t1 - o.t0) * i) / Math.max(1, pts.length - 1) + 0.28, tf(1), EASE.pop]]) : "";
      return `<div class="dot ${cls}" style="left:${r1(p.x - r)}px;top:${r1(p.y - r)}px;width:${r1(r * 2)}px;height:${r1(r * 2)}px;background:${o.color}"></div>`;
    })
    .join("");
}

/**
 * Word-by-word captions in a white pill: each word lights up (brand colour
 * behind it) as it's "said"; the pill appears with the first word and goes
 * with the line. Times are seconds on the composition's timeline.
 */
export function captionHtml(tl: Timeline, c: Colors, o: { text: string; t0: number; t1: number; y: number; px: number }): string {
  const words = o.text.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const span = Math.max(0.6, o.t1 - o.t0 - 0.55);
  const weights = words.map((w) => 0.35 + w.length * 0.06);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const box = tl.track([
    [o.t0, tf(0, 0, 24, 0.94)],
    [o.t0 + 0.3, tf(1), EASE.pop],
    [o.t1 - 0.22, tf(1)],
    [o.t1, tf(0, 0, -12, 0.98), EASE.in],
  ]);
  const spans = words
    .map((w, k) => {
      const ts = o.t0 + 0.12 + (acc / total) * span;
      acc += weights[k]!;
      const te = o.t0 + 0.12 + (acc / total) * span;
      const cls = tl.track([
        [ts - 0.01, `opacity:0;background-color:${c.primary};color:${c.onPrimary};transform:translate3d(0,.15em,0)`],
        [ts + 0.08, `opacity:1;background-color:${c.primary};color:${c.onPrimary};transform:translate3d(0,0,0)`, EASE.out],
        [te, `opacity:1;background-color:${c.primary};color:${c.onPrimary}`],
        [te + 0.12, `opacity:1;background-color:rgba(255,255,255,0);color:${c.ink};transform:translate3d(0,0,0)`, EASE.out],
      ]);
      return `<span class="capw ${cls}">${esc(w)}</span>`;
    })
    .join(" ");
  return `<div class="cap ${box}" style="top:${o.y}px"><div class="capbox" data-text="caption" style="font-size:${o.px}px">${spans}</div></div>`;
}

/** Big words slamming in one by one (the hook). */
export function slamWords(tl: Timeline, text: string, t0: number, stagger = 0.11): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, k) => {
      const t = t0 + k * stagger;
      const cls = tl.track([
        [t, `opacity:0;transform:translate3d(0,.18em,0) scale(1.28)`],
        [t + 0.08, `opacity:1;transform:translate3d(0,.02em,0) scale(1.06)`, EASE.out],
        [t + 0.34, `opacity:1;transform:translate3d(0,0,0) scale(1)`, EASE.pop],
      ]);
      return `<span class="w ${cls}" style="transform-origin:50% 70%">${esc(w)}</span>`;
    })
    .join(" ");
}

/** Gentle floating (stickers): up and down around their place, the whole time. */
export function bob(tl: Timeline, T: number, amp: number, period: number, phase = 0, rot = 0): string {
  const stops: Array<[number, string, string?]> = [];
  for (let t = 0, k = 0; t <= T + period; t += period / 2, k++) stops.push([t + phase * period, `transform:translate3d(0,${k % 2 ? amp : -amp}px,0) rotate(${k % 2 ? rot : -rot}deg)`, EASE.inOut]);
  return tl.track(stops.map(([t, css, e]) => [Math.max(0, Math.min(T, t)), css, e] as [number, string, string?]));
}

/** clip-path circle reveal (the brand dot growing into the next scene). */
export function circleReveal(tl: Timeline, o: { x: number; y: number; t0: number; dur: number; maxR: number }): string {
  return tl.track([
    [0, `clip-path:circle(0px at ${r1(o.x)}px ${r1(o.y)}px)`],
    [o.t0, `clip-path:circle(0px at ${r1(o.x)}px ${r1(o.y)}px)`],
    [o.t0 + o.dur, `clip-path:circle(${r1(o.maxR)}px at ${r1(o.x)}px ${r1(o.y)}px)`, EASE.inOut],
  ]);
}

/** Camera inside a card: scale `z` from the card's top-left so `focus` (px in card) lands on `target` (px in card), never showing past the screen's edges. Pure. */
export function innerZoom(o: { cardW: number; viewH: number; contentH: number; focus: Point; target: Point; z: number }): { tx: number; ty: number } {
  const tx = Math.min(0, Math.max(o.cardW - o.z * o.cardW, o.target.x - o.z * o.focus.x));
  const ty = Math.min(0, Math.max(o.viewH - o.z * o.contentH, o.target.y - o.z * o.focus.y));
  return { tx, ty };
}

/** Zoom the camera on a card so `focus` (px in card) lands on `target` (px in frame). Pure. */
export function zoomTransform(o: { cardX: number; cardY: number; cardW: number; cardH: number; focus: Point; target: Point; z: number }): { tx: number; ty: number } {
  const C = { x: o.cardX + o.cardW / 2, y: o.cardY + o.cardH / 2 };
  const F = { x: o.cardX + o.focus.x, y: o.cardY + o.focus.y };
  return { tx: o.target.x - C.x - o.z * (F.x - C.x), ty: o.target.y - C.y - o.z * (F.y - C.y) };
}
