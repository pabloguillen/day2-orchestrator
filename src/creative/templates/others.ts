import { docHtml, EASE, esc, fileUri, r1, tf, Timeline } from "../motion/engine";
import type { Cue } from "../motion/audio";
import { endCard } from "./steps";
import {
  baseCss,
  bob,
  captionHtml,
  cardHtml,
  circleReveal,
  colors,
  iconHtml,
  innerZoom,
  labels,
  onCard,
  pickSticker,
  popoutHtml,
  regionCenter,
  SAFE_916,
  screenGeom,
  screenImg,
  slamWords,
  stickerHtml,
  wordSpans,
  type Colors,
} from "./parts";
import { SIZES, type Ratio, type RenderInput, type ScreenAsset, type ShotStep, type SlideComposition, type VideoComposition } from "./types";

/**
 * Feature spotlight, POV hook, problem → solution and launch: the other
 * story shapes. They share the step "scene" below (headline, caption, the
 * real screen in a card with the camera zooming to what matters, a tap) and
 * the end card.
 */

const screenOf = (i: RenderInput, idx: number): ScreenAsset => i.screens[Math.max(0, Math.min(i.screens.length - 1, idx))]!;
const S = SAFE_916;
const TW = S.right - S.left;
const W9 = SIZES["9:16"].W;
const H9 = SIZES["9:16"].H;

type SceneOut = { html: string; cues: Cue[] };

/**
 * App scenes: one per step, back to back from `t0`, `dur` each, on a
 * background (`bg` css). The card rises on the first, screens push between
 * steps, the camera zooms into each focus, taps ripple, captions run.
 */
function appScenes(tl: Timeline, i: RenderInput, c: Colors, steps: ShotStep[], o: { t0: number; dur: number; end: number; bg: string; chip?: { text: string; bg: string; fg: string } | null; titleColor?: string; cardY?: number }): SceneOut {
  const k = i.kit;
  const cues: Cue[] = [];
  const cardW = 720;
  const cardX = (W9 - cardW) / 2;
  const cardY = o.cardY ?? 720;
  const radius = Math.round(k.radius * 2.8);
  const cardH = Math.max(900, ...steps.map((st) => Math.min(screenGeom(screenOf(i, st.screen), cardW).visibleH, H9 - cardY + 120)));
  const at = (j: number) => o.t0 + j * o.dur;
  const n = steps.length;
  const rise = tl.track([[o.t0 - 0.15, tf(1, 0, 780)], [o.t0 + 0.6, tf(1), EASE.out]]);
  const camStops: Array<[number, string, string?]> = [[0, "transform:translate3d(0,0,0) scale(1)"]];
  const screens: string[] = [];
  const taps: string[] = [];
  const heads: string[] = [];
  const caps: string[] = [];
  steps.forEach((st, j) => {
    const s0 = at(j);
    const s = screenOf(i, st.screen);
    const inT = j === 0 ? null : s0 - 0.12;
    const outT = j < n - 1 ? at(j + 1) - 0.12 : null;
    const scr = tl.track([
      ...(inT === null ? ([[0, tf(1)]] as Array<[number, string, string?]>) : ([[inT, tf(1, cardW * 1.02)], [inT + 0.55, tf(1), EASE.inOut]] as Array<[number, string, string?]>)),
      ...(outT === null ? [] : ([[outT, tf(1)], [outT + 0.55, tf(1, -cardW * 0.32)], [outT + 0.56, tf(0, -cardW * 0.32)]] as Array<[number, string, string?]>)),
    ]);
    screens.push(`<div class="abs ${scr}" style="inset:0;z-index:${j + 1};background:#fff">${screenImg(s, cardW)}</div>`);
    if (j > 0) cues.push({ t: s0 - 0.12, kind: "whoosh" });
    if (st.focus) {
      const f = onCard(regionCenter(st.focus), s, cardW);
      const z = Math.max(1.12, Math.min(2.1, 0.5 / Math.max(0.1, st.focus.w)));
      const viewH = Math.min(cardH, H9 - cardY);
      const { tx, ty } = innerZoom({ cardW, viewH, contentH: screenGeom(s, cardW).visibleH, focus: f, target: { x: cardW / 2, y: (S.bottom - cardY) * 0.55 }, z });
      camStops.push([s0 + 0.7, "transform:translate3d(0,0,0) scale(1)"], [s0 + 1.55, `transform:translate3d(${r1(tx)}px,${r1(ty)}px,0) scale(${z.toFixed(3)})`, EASE.inOut], [s0 + o.dur - 0.42, `transform:translate3d(${r1(tx)}px,${r1(ty)}px,0) scale(${z.toFixed(3)})`], [s0 + o.dur - 0.02, "transform:translate3d(0,0,0) scale(1)", EASE.inOut]);
    }
    if (st.tap) {
      const p = onCard(st.tap, s, cardW);
      const tt = s0 + (st.focus ? 1.8 : 1.1);
      const finger = tl.track([[tt - 0.45, tf(0, 30, 40, 1.15)], [tt - 0.15, tf(0.95, 0, 0, 1.15), EASE.out], [tt, tf(0.95, 0, 0, 0.86), EASE.in], [tt + 0.18, tf(0.95, 0, 0, 1), EASE.out], [tt + 0.6, tf(0, 0, 0, 1)]]);
      const ring = tl.track([[tt, tf(0.9, 0, 0, 0.3)], [tt + 0.55, tf(0, 0, 0, 1.9), EASE.out]]);
      taps.push(`<div class="dot ${ring}" style="left:${r1(p.x - 60)}px;top:${r1(p.y - 60)}px;width:120px;height:120px;border:7px solid ${c.primary};z-index:20"></div><div class="dot ${finger}" style="left:${r1(p.x - 42)}px;top:${r1(p.y - 42)}px;width:84px;height:84px;background:rgba(255,255,255,.92);box-shadow:0 10px 26px rgba(0,0,0,.28);z-index:21"></div>`);
      cues.push({ t: tt, kind: "tap" });
    }
    const hOut = j < n - 1 ? at(j + 1) - 0.18 : o.end + 0.1;
    const head = tl.track([[s0, tf(0, 0, 46)], [s0 + 0.5, tf(1), EASE.out], [hOut, tf(1)], [hOut + 0.3, tf(0, 0, -30), EASE.in]]);
    const stick = pickSticker(k, st.sticker);
    heads.push(`<div class="abs ${head}" style="left:${S.left}px;top:${S.top}px;width:${TW}px">
  ${o.chip ? `<span class="chip" data-text="badge" style="font-size:40px;background:${o.chip.bg};color:${o.chip.fg}">${esc(o.chip.text)}</span>` : ""}
  <div class="abs" data-fit-box="1" style="left:0;top:${o.chip ? 96 : 20}px;width:${stick ? TW - 150 : TW}px;height:${cardY - S.top - (o.chip ? 300 : 230)}px"><div class="display" data-fit data-min="56" data-text="headline" style="font-size:96px;color:${o.titleColor ?? c.ink};width:${stick ? TW - 150 : TW}px">${wordSpans(st.headline)}</div></div>
  ${stick ? `<div class="abs ${bob(tl, tl.T, 9, 1.8, j * 0.3, 3)}" style="left:0;top:0">${stickerHtml(k, stick, { x: TW - 60, y: 120, size: 170, rot: 10 })}</div>` : ""}
</div>`);
    if (st.caption) caps.push(captionHtml(tl, c, { text: st.caption, t0: s0 + 0.35, t1: (j < n - 1 ? at(j + 1) : o.end) - 0.05, y: cardY - 150, px: 46 }));
  });
  camStops.push([tl.T, "transform:translate3d(0,0,0) scale(1)"]);
  const cam = tl.track(camStops);
  const html = `<div class="abs" style="inset:0;background:${o.bg}">
  <div class="abs ${rise}" style="left:0;top:0;width:${W9}px;height:${H9}px">
    <div class="card" style="left:${cardX}px;top:${cardY}px;width:${cardW}px;height:${cardH}px;border-radius:${radius}px"><div class="abs ${cam}" style="left:0;top:0;width:${cardW}px;height:${cardH}px;transform-origin:0 0">${screens.join("")}${taps.join("")}</div></div>
  </div>
  ${heads.join("")}
  ${caps.join("")}
</div>`;
  return { html, cues };
}

function finish(i: RenderInput, c: Colors, tl: Timeline, layers: string, cues: Cue[], sample: number[], extra: Partial<VideoComposition> = {}): VideoComposition {
  const T = tl.T;
  return {
    kind: "video",
    ratio: "9:16",
    W: W9,
    H: H9,
    seconds: r1(T),
    html: docHtml({ W: W9, H: H9, lang: i.kit.language, kit: { ...i.kit, background: c.primary }, timeline: tl, css: baseCss(i.kit, c), body: layers }),
    cues: cues.sort((a, b) => a.t - b.t),
    sampleTimes: sample.map((t) => r1(Math.max(0.1, Math.min(T - 0.05, t)))),
    ...extra,
  };
}

const END = 2.7;
function withEnd(tl: Timeline, i: RenderInput, c: Colors, cues: Cue[]): string {
  const e0 = tl.T - END;
  cues.push({ t: e0 - 0.05, kind: "whoosh" }, { t: e0 + 0.4, kind: "pop" });
  return `<div class="abs ${circleReveal(tl, { x: W9 / 2, y: 820, t0: e0 - 0.1, dur: 0.7, maxR: 2300 })}" style="inset:0">${endCard(tl, i, c, { t0: e0, W: W9, H: H9, iconY: 760, compact: false })}</div>`;
}

// ---------------------------------------------------------------- feature spotlight

export function spotlightVideo(i: RenderInput): VideoComposition {
  const c = colors(i.kit);
  const steps = i.shots.steps.slice(0, 3);
  const HOOK = 1.9;
  const DUR = 2.8;
  const T = HOOK + steps.length * DUR + END;
  const tl = new Timeline(T);
  const cues: Cue[] = [{ t: 0.02, kind: "pop" }];
  const L = labels(i.kit.language);
  // Hook on the brand colour, then the scenes on light.
  const hook = `<div class="abs" style="inset:0;background:${c.primary}">
  <div class="abs" style="left:${S.left}px;top:${S.top + 20}px"><span class="chip" data-text="kicker" style="font-size:40px;background:${c.ink};color:${c.primary}">${esc(i.shots.kicker ?? L.isNew)}</span></div>
  <div class="abs" data-fit-box="1" style="left:${S.left}px;top:${S.top + 130}px;width:${TW}px;height:760px"><div class="display" data-fit data-min="84" data-text="hook" style="font-size:156px;color:${c.ink};width:${TW}px">${slamWords(tl, i.shots.hook, 0, 0.09)}</div></div>
  ${stickerHtml(i.kit, pickSticker(i.kit, steps[0]?.sticker, "sparkles"), { x: 820, y: 1260, size: 260, rot: 12 })}
</div>`;
  const reveal = circleReveal(tl, { x: W9 / 2, y: 1400, t0: HOOK - 0.4, dur: 0.75, maxR: 2300 });
  cues.push({ t: HOOK - 0.35, kind: "whoosh" });
  const sc = appScenes(tl, i, c, steps, { t0: HOOK, dur: DUR, end: T - END, bg: `radial-gradient(900px 700px at 100% 0%, ${c.primarySoft}, ${c.bg} 70%)` });
  cues.push(...sc.cues);
  return finish(i, c, tl, `${hook}<div class="abs ${reveal}" style="inset:0">${sc.html}</div>${withEnd(tl, i, c, cues)}`, cues, [0.8, ...steps.map((_, j) => HOOK + j * DUR + 1.9), T - 0.6]);
}

/** One 4:5 / 1:1 still: the headline, the screen, up to two details lifted off it. */
export function spotlightSlides(i: RenderInput, ratio: Ratio): SlideComposition {
  const { W, H } = SIZES[ratio];
  const k = i.kit;
  const c = colors(k);
  const sq = ratio === "1:1";
  const st = i.shots.steps[0];
  const s = screenOf(i, st?.screen ?? 0);
  const cardW = sq ? 440 : 560;
  const cardX = sq ? W - cardW - 80 : (W - cardW) / 2;
  const cardY = sq ? 300 : 470;
  const g = screenGeom(s, cardW);
  const M = 84;
  const pops = i.shots.steps
    .slice(0, 2)
    .filter((x) => x.focus && x.focus.h <= 0.3 && x.screen === (st?.screen ?? 0))
    .map((x) => popoutHtml({ s, focus: x.focus!, cardX, cardY, cardW, maxW: W - 120, minX: 50, maxX: W - 50, minY: cardY + 60, maxY: H - 40, ring: c.primary, radius: Math.round(k.radius * 1.4), zoom: 1.6 }).html)
    .join("");
  const tw = sq ? W - cardW - 80 - M - 30 : W - 2 * M;
  const body = `<div class="abs" style="inset:0;background:radial-gradient(900px 700px at 100% 0%, ${c.primarySoft}, ${c.bg} 70%)"></div>
<div class="abs" style="left:${M}px;top:${sq ? 90 : 96}px;width:${tw}px;display:flex;flex-direction:column;gap:22px;align-items:flex-start">
  <span class="chip" data-text="kicker" style="font-size:${sq ? 34 : 40}px;background:${c.primary};color:${c.onPrimary}">${esc(i.shots.kicker ?? labels(k.language).isNew)}</span>
  <div class="display" data-fit data-min="48" data-maxh="${sq ? 420 : 250}" data-text="hook" style="font-size:${sq ? 84 : 100}px;color:${c.ink};width:${tw}px">${wordSpans(i.shots.hook)}</div>
  ${st?.caption ? `<div class="body" data-fit data-min="26" data-maxh="${sq ? 200 : 96}" data-text="sub" style="font-size:${sq ? 34 : 38}px;color:${c.inkSoft};width:${tw}px">${esc(st.caption)}</div>` : ""}
</div>
${cardHtml({ s, x: cardX, y: cardY, w: cardW, h: Math.min(g.visibleH, H - cardY + 200), radius: Math.round(k.radius * 2.4) })}
${pops}
${stickerHtml(k, pickSticker(k, st?.sticker, "sparkles"), sq ? { x: cardX - 20, y: cardY + 30, size: 150, rot: -10 } : { x: W - M - 60, y: 150, size: 160, rot: 10 })}`;
  return { kind: "slides", ratio, W, H, count: 1, html: docHtml({ W, H, lang: k.language, kit: k, css: baseCss(k, c), body }) };
}

// ---------------------------------------------------------------- POV / relatable hook

export function povVideo(i: RenderInput): VideoComposition {
  const c = colors(i.kit);
  const k = i.kit;
  const steps = i.shots.steps.slice(0, 2);
  const A = 3.4;
  const DUR = 2.9;
  const T = A + steps.length * DUR + END;
  const tl = new Timeline(T);
  const cues: Cue[] = [];
  const b = i.shots.broll !== null ? i.broll[i.shots.broll] : i.broll[0];
  // Scene A: real-life b-roll full-bleed (video frames swapped per frame, or a photo with a slow push), the POV line on top.
  const push = tl.track([[0, "transform:scale(1.08) translate3d(0,0,0)"], [A + 0.4, "transform:scale(1.22) translate3d(-10px,-24px,0)", EASE.linear]]);
  const bg =
    b?.kind === "video"
      ? `<img id="broll" class="abs" style="inset:0;width:100%;height:100%;object-fit:cover" alt=""><script>(()=>{const im=document.getElementById('broll');let cur='';window.__onSeek=(t)=>{const a=window.__broll||[];if(!a.length)return;const src=a[Math.min(a.length-1,Math.floor(t*15))];if(src===cur)return;cur=src;im.src=src;return im.decode().catch(()=>{})};})()</script>`
      : b
        ? `<div class="abs ${push}" style="inset:-40px"><img src="${fileUri(b.file) ?? ""}" style="width:100%;height:100%;object-fit:cover;filter:saturate(1.05) contrast(1.04)" alt=""></div>`
        : `<div class="abs ${push}" style="inset:-60px;background:${c.ink}">${screenImg(screenOf(i, 0), W9 + 120, "", "filter:blur(18px) brightness(.7);transform:scale(1.1)")}</div>`;
  const povText = i.shots.pov ?? i.shots.hook;
  const words = povText.replace(/^POV:\s*/i, "");
  const A_layer = `<div class="abs" style="inset:0;background:#000;overflow:hidden">${bg}
  <div class="abs" style="left:0;right:0;top:0;height:1100px;background:linear-gradient(180deg,rgba(0,0,0,.62),rgba(0,0,0,0))"></div>
  <div class="abs" style="left:${S.left}px;top:${S.top + 40}px;width:${TW}px">
    <span class="chip ${tl.track([[0, tf(0, 0, 0, 0.6)], [0.25, tf(1), EASE.pop]])}" data-text="kicker" style="font-size:46px;background:${c.primary};color:${c.onPrimary}">POV</span>
    <div class="display" data-text="pov" style="margin-top:28px;font-size:104px;color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.45);width:${TW}px">${slamWords(tl, words, 0.25, 0.12)}</div>
  </div>
</div>`;
  cues.push({ t: 0.25, kind: "pop" });
  // Cut to the app: a quick flash and the brand colour.
  const cut = tl.track([[0, "opacity:0"], [A - 0.08, "opacity:0"], [A, "opacity:1"]]);
  const flash = tl.track([[A - 0.02, "opacity:0"], [A, "opacity:.9"], [A + 0.25, "opacity:0", EASE.out]]);
  cues.push({ t: A, kind: "whoosh" });
  const sc = appScenes(tl, i, c, steps, { t0: A, dur: DUR, end: T - END, bg: c.primary, titleColor: c.onPrimary });
  cues.push(...sc.cues);
  return finish(i, c, tl, `${A_layer}<div class="abs ${cut}" style="inset:0">${sc.html}</div><div class="abs ${flash}" style="inset:0;background:#fff;pointer-events:none"></div>${withEnd(tl, i, c, cues)}`, cues, [1.4, A + 1.9, ...steps.slice(1).map((_, j) => A + (j + 1) * DUR + 1.9), T - 0.6], b?.kind === "video" ? { brollFrames: { fps: 15, count: Math.ceil(A * 15) } } : {});
}

// ---------------------------------------------------------------- problem → solution

function bubbles(tl: Timeline | null, c: Colors, k: RenderInput["kit"], lines: string[], o: { x: number; y: number; w: number; px: number; t0?: number; gap?: number }): string {
  return lines
    .slice(0, 5)
    .map((line, j) => {
      const right = j % 2 === 1;
      const t = (o.t0 ?? 0) + j * (o.gap ?? 0.5);
      const cls = tl ? tl.track([[t, tf(0, right ? 40 : -40, 20, 0.85)], [t + 0.35, tf(1), EASE.pop]]) : "";
      return `<div class="${cls}" style="display:flex;justify-content:${right ? "flex-end" : "flex-start"}"><div class="body" data-text="bubble" style="max-width:${Math.round(o.w * 0.82)}px;font-size:${o.px}px;font-weight:700;padding:.62em .95em;border-radius:1.1em;${right ? `border-bottom-right-radius:.3em;background:${c.ink};color:#fff` : `border-bottom-left-radius:.3em;background:#fff;color:${c.ink};box-shadow:0 6px 18px rgba(0,0,0,.08)`}">${esc(line)}</div></div>`;
    })
    .join("");
}

export function problemVideo(i: RenderInput): VideoComposition {
  const c = colors(i.kit);
  const k = i.kit;
  const L = labels(k.language);
  const steps = i.shots.steps.slice(0, 2);
  const lines = (i.shots.problem.length ? i.shots.problem : [i.shots.hook]).slice(0, 4);
  const A = Math.max(3.2, 1.4 + lines.length * 0.55);
  const DUR = 2.9;
  const T = A + steps.length * DUR + END;
  const tl = new Timeline(T);
  const cues: Cue[] = [{ t: 0.02, kind: "pop" }];
  lines.forEach((_, j) => cues.push({ t: 0.9 + j * 0.5, kind: "tap" }));
  const gray = "#ecebe8";
  const shake = tl.track([[A - 0.7, "transform:translate3d(0,0,0)"], [A - 0.6, "transform:translate3d(-10px,0,0)"], [A - 0.5, "transform:translate3d(10px,0,0)"], [A - 0.4, "transform:translate3d(-6px,0,0)"], [A - 0.3, "transform:translate3d(0,0,0)"]]);
  const A_layer = `<div class="abs" style="inset:0;background:${gray}">
  <div class="abs" style="left:${S.left}px;top:${S.top + 20}px"><span class="chip" data-text="kicker" style="font-size:40px;background:${c.ink};color:#fff">${esc(L.before)}</span></div>
  <div class="abs" data-fit-box="1" style="left:${S.left}px;top:${S.top + 130}px;width:${TW}px;height:400px"><div class="display" data-fit data-min="70" data-text="hook" style="font-size:120px;color:${c.ink};width:${TW}px">${slamWords(tl, i.shots.hook, 0, 0.09)}</div></div>
  <div class="abs ${shake}" style="left:${S.left}px;top:760px;width:${TW}px;display:flex;flex-direction:column;gap:28px">${bubbles(tl, c, k, lines, { x: 0, y: 0, w: TW, px: 58, t0: 0.9, gap: 0.5 })}</div>
</div>`;
  const reveal = circleReveal(tl, { x: W9 / 2, y: 1200, t0: A - 0.2, dur: 0.75, maxR: 2300 });
  cues.push({ t: A - 0.15, kind: "whoosh" });
  const sc = appScenes(tl, i, c, steps, { t0: A + 0.3, dur: DUR, end: T - END, bg: `radial-gradient(900px 700px at 0% 0%, ${c.primarySoft}, ${c.bg} 70%)`, chip: { text: L.after, bg: c.primary, fg: c.onPrimary } });
  cues.push(...sc.cues);
  return finish(i, c, tl, `${A_layer}<div class="abs ${reveal}" style="inset:0">${sc.html}</div>${withEnd(tl, i, c, cues)}`, cues, [1.0, A - 0.5, A + 0.3 + 1.9, T - 0.6]);
}

/** Two slides: before (the chat chaos) → after (the app). */
export function problemSlides(i: RenderInput, ratio: Ratio): SlideComposition {
  const { W, H } = SIZES[ratio];
  const k = i.kit;
  const c = colors(k);
  const L = labels(k.language);
  const sq = ratio === "1:1";
  const M = 84;
  const st = i.shots.steps[0];
  const s = screenOf(i, st?.screen ?? 0);
  const cardW = sq ? 440 : 580;
  const g = screenGeom(s, cardW);
  const cardX = W + (W - cardW) / 2;
  const cardY = sq ? 330 : 520;
  const pop = st?.focus && st.focus.h <= 0.3 ? popoutHtml({ s, focus: st.focus, cardX, cardY, cardW, maxW: W - 120, minX: W + 50, maxX: 2 * W - 50, minY: cardY + 60, maxY: H - 40, ring: c.primary, radius: Math.round(k.radius * 1.4), zoom: 1.6 }).html : "";
  const lines = (i.shots.problem.length ? i.shots.problem : [i.shots.hook]).slice(0, sq ? 3 : 4);
  const body = `<div class="abs" style="left:0;top:0;width:${W}px;height:${H}px;background:#ecebe8"></div>
<div class="abs" style="left:${W}px;top:0;width:${W}px;height:${H}px;background:radial-gradient(900px 700px at 0% 0%, ${c.primarySoft}, ${c.bg} 70%)"></div>
<div class="abs" style="left:${M}px;top:${sq ? 80 : 96}px;width:${W - 2 * M}px;display:flex;flex-direction:column;gap:24px;align-items:flex-start">
  <span class="chip" data-text="kicker" style="font-size:${sq ? 34 : 40}px;background:${c.ink};color:#fff">${esc(L.before)}</span>
  <div class="display" data-fit data-min="56" data-maxh="${sq ? 240 : 300}" data-text="hook" style="font-size:${sq ? 92 : 108}px;color:${c.ink};width:${W - 2 * M}px">${wordSpans(i.shots.hook)}</div>
</div>
<div class="abs" style="left:${M}px;top:${sq ? 440 : 560}px;width:${W - 2 * M}px;display:flex;flex-direction:column;gap:20px">${bubbles(null, c, k, lines, { x: 0, y: 0, w: W - 2 * M, px: sq ? 38 : 44 })}</div>
<div class="abs" style="left:${W - 70}px;top:${H / 2 - 70}px;width:140px;height:140px;border-radius:50%;background:${c.primary};display:flex;align-items:center;justify-content:center;box-shadow:0 20px 40px rgba(0,0,0,.18);z-index:5"><svg width="64" height="64" viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="${c.onPrimary}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
<div class="abs" style="left:${W + M}px;top:${sq ? 80 : 96}px;width:${W - 2 * M}px;display:flex;flex-direction:column;gap:24px;align-items:flex-start">
  <span class="chip" data-text="badge" style="font-size:${sq ? 34 : 40}px;background:${c.primary};color:${c.onPrimary}">${esc(L.after)}</span>
  <div class="display" data-fit data-min="48" data-maxh="${sq ? 150 : 200}" data-text="headline" style="font-size:${sq ? 76 : 88}px;color:${c.ink};width:${W - 2 * M}px">${wordSpans(st?.headline ?? k.appName)}</div>
</div>
${cardHtml({ s, x: cardX, y: cardY, w: cardW, h: Math.min(g.visibleH, H - cardY + 200), radius: Math.round(k.radius * 2.4) })}
${pop}`;
  return { kind: "slides", ratio, W, H, count: 2, html: docHtml({ W: 2 * W, H, lang: k.language, kit: k, css: baseCss(k, c), body }) };
}

// ---------------------------------------------------------------- launch

function rays(c: Colors, cls = "") {
  return `<div class="abs ${cls}" style="left:-900px;top:-500px;width:2880px;height:2880px;background:repeating-conic-gradient(from 0deg at 50% 50%, ${c.primary} 0deg 7.5deg, ${c.primarySoft} 7.5deg 15deg);opacity:.9"></div><div class="abs" style="inset:0;background:radial-gradient(closest-side at 50% 42%, rgba(255,255,255,.55), rgba(255,255,255,0) 70%)"></div>`;
}

export function launchVideo(i: RenderInput): VideoComposition {
  const c = colors(i.kit);
  const k = i.kit;
  const L = labels(k.language);
  const fanSteps = i.shots.steps.slice(0, 3);
  const A = 2.8;
  const FAN = 3.4;
  const T = A + FAN + END;
  const tl = new Timeline(T);
  const cues: Cue[] = [{ t: 0.15, kind: "pop" }];
  const spin = tl.track([[0, "transform:rotate(0deg)"], [T, "transform:rotate(40deg)", EASE.linear]]);
  const iconIn = tl.track([[0.1, tf(0, 0, 0, 0.2, -20)], [0.75, tf(1, 0, 0, 1, 0), EASE.pop], [A, tf(1, 0, -300, 0.55), EASE.inOut]]);
  const hookOut = tl.track([[A - 0.1, tf(1)], [A + 0.35, tf(0, 0, -80), EASE.in]]);
  const fan = fanSteps
    .map((st, j) => {
      const s = screenOf(i, st.screen);
      const w = 470;
      const g = screenGeom(s, w);
      const rot = [-11, 0, 11][fanSteps.length === 1 ? 1 : fanSteps.length === 2 ? j * 2 : j]!;
      const dx = rot * 26;
      const t = A + 0.1 + j * 0.16;
      const cls = tl.track([[t, tf(0, dx * 1.6, 900, 0.9, rot * 1.6)], [t + 0.7, tf(1, dx, Math.abs(rot) * 7, 1, rot), EASE.out]]);
      return `<div class="abs ${cls}" style="left:${(W9 - w) / 2}px;top:820px;z-index:${j === 1 ? 3 : 1}">${cardHtml({ s, x: 0, y: 0, w, h: Math.min(g.visibleH, 1200), radius: Math.round(k.radius * 2.2) })}</div>`;
    })
    .join("");
  cues.push({ t: A + 0.1, kind: "whoosh" });
  const capLine = i.shots.steps[0]?.caption;
  const layer = `<div class="abs" style="inset:0;background:${c.primary};overflow:hidden">${rays(c, spin)}
  <div class="abs ${iconIn}" style="left:0;top:0;width:${W9}px;height:${H9}px">${iconHtml(k, { x: W9 / 2, y: 760, size: 380 })}</div>
  <div class="abs" style="left:0;top:${S.top + 10}px;width:${W9}px;text-align:center"><span class="chip ${tl.track([[0, tf(1)], [A - 0.2, tf(1)], [A + 0.2, tf(0, 0, -30), EASE.in]])}" data-text="kicker" style="font-size:44px;background:${c.ink};color:${c.primary}">${esc(i.shots.kicker ?? L.isNew)}</span></div>
  <div class="abs ${hookOut}" data-fit-box="1" style="left:${S.left}px;top:1030px;width:${TW}px;height:420px;text-align:center"><div class="display" data-fit data-min="80" data-text="hook" style="font-size:150px;color:${c.ink};width:${TW}px">${slamWords(tl, i.shots.hook, 0.55, 0.12)}</div></div>
  ${fan}
  ${capLine ? captionHtml(tl, c, { text: capLine, t0: A + 0.6, t1: T - END - 0.05, y: 640, px: 50 }) : ""}
</div>`;
  return finish(i, c, tl, `${layer}${withEnd(tl, i, c, cues)}`, cues, [0.9, A + 1.6, T - 0.6]);
}

export function launchSlides(i: RenderInput, ratio: Ratio): SlideComposition {
  const { W, H } = SIZES[ratio];
  const k = i.kit;
  const c = colors(k);
  const L = labels(k.language);
  const sq = ratio === "1:1";
  const steps = i.shots.steps.slice(0, 3);
  const fan = steps
    .map((st, j) => {
      const s = screenOf(i, st.screen);
      const w = sq ? 300 : 380;
      const g = screenGeom(s, w);
      const rot = [-11, 0, 11][steps.length === 1 ? 1 : steps.length === 2 ? j * 2 : j]!;
      return `<div class="abs" style="left:${(W - w) / 2 + rot * (sq ? 22 : 26)}px;top:${(sq ? 600 : 790) + Math.abs(rot) * 6}px;transform:rotate(${rot}deg);z-index:${j === 1 ? 3 : 1}">${cardHtml({ s, x: 0, y: 0, w, h: Math.min(g.visibleH, 900), radius: Math.round(k.radius * 2) })}</div>`;
    })
    .join("");
  const isz = sq ? 190 : 240;
  const body = `<div class="abs" style="inset:0;background:${c.primary};overflow:hidden">${rays(c)}</div>
<div class="abs" style="left:0;top:${sq ? 60 : 80}px;width:${W}px;text-align:center"><span class="chip" data-text="kicker" style="font-size:${sq ? 34 : 40}px;background:${c.ink};color:${c.primary}">${esc(i.shots.kicker ?? L.isNew)}</span></div>
${iconHtml(k, { x: W / 2, y: sq ? 270 : 330, size: isz })}
<div class="abs" style="left:70px;top:${sq ? 390 : 480}px;width:${W - 140}px;text-align:center"><div class="display" data-fit data-min="56" data-maxh="${sq ? 190 : 270}" data-text="hook" style="font-size:${sq ? 92 : 112}px;color:${c.ink};width:${W - 140}px">${wordSpans(i.shots.hook)}</div></div>
${fan}`;
  return { kind: "slides", ratio, W, H, count: 1, html: docHtml({ W, H, lang: k.language, kit: k, css: baseCss(k, c), body }) };
}
