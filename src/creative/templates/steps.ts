import { docHtml, EASE, esc, r1, tf, Timeline } from "../motion/engine";
import type { Cue } from "../motion/audio";
import {
  baseCss,
  bob,
  buttonHtml,
  captionHtml,
  cardHtml,
  circleReveal,
  colors,
  iconHtml,
  labels,
  onCard,
  pickSticker,
  regionCenter,
  SAFE_916,
  screenGeom,
  screenImg,
  slamWords,
  stickerHtml,
  trailHtml,
  trailPoints,
  wordSpans,
  innerZoom,
  popoutHtml,
  type Colors,
} from "./parts";
import { SIZES, type Ratio, type RenderInput, type ScreenAsset, type SlideComposition, type VideoComposition } from "./types";

/**
 * "How it works" (and "What's new", the same structure with "New" badges):
 * App Store-screenshot storytelling — one step per screen, a big step
 * number, a short headline, the real screen large and bleeding off the
 * bottom, the detail that matters magnified (slides) or zoomed into
 * (video), the brand's dotted trail running through, and an end card with
 * the real icon.
 */

type Mode = "steps" | "new";
const screenOf = (i: RenderInput, idx: number): ScreenAsset => i.screens[Math.max(0, Math.min(i.screens.length - 1, idx))]!;

// ---------------------------------------------------------------- video

export function stepsVideo(i: RenderInput, mode: Mode = "steps"): VideoComposition {
  const { W, H } = SIZES["9:16"];
  const k = i.kit;
  const c = colors(k);
  const L = labels(k.language);
  const steps = i.shots.steps.slice(0, 6);
  const n = Math.max(1, steps.length);
  const HOOK = 2.3;
  const STEP = 2.9;
  const END = 2.7;
  const T = HOOK + n * STEP + END;
  const tl = new Timeline(T);
  const cues: Cue[] = [];
  const S = SAFE_916;
  const tw = S.right - S.left;

  // ---- hook (brand colour): kicker chip, the hook slamming in, the first screen peeking up.
  const kicker = i.shots.kicker ?? (mode === "new" ? `${L.isNew}${i.shots.version ? ` · ${L.version} ${i.shots.version}` : ""}` : L.howItWorks);
  const chipIn = tl.track([[0, tf(1, 0, 0, 1)]]);
  const peekS = screenOf(i, steps[0]?.screen ?? 0);
  const peekW = 600;
  const peekG = screenGeom(peekS, peekW);
  const peek = tl.track([
    [0.25, tf(0, 0, 520, 1, 9)],
    [0.95, tf(1, 0, 0, 1, 7), EASE.out],
    [HOOK - 0.15, tf(1, 0, -30, 1, 6)],
  ]);
  const hookSticker = pickSticker(k, steps[0]?.sticker, "sparkles", "fire", "party");
  const hookStick = tl.track([[0.55, tf(0, 0, 0, 0.3, -30)], [0.95, tf(1, 0, 0, 1, 0), EASE.pop]]);
  const hookLayer = `<div class="abs" style="inset:0;background:${c.primary}">
  <div class="abs" style="left:-220px;top:-260px;width:900px;height:900px;border-radius:50%;background:${c.primarySoft};opacity:.55"></div>
  <div class="abs ${chipIn}" style="left:${S.left}px;top:${S.top + 20}px"><span class="chip" data-text="kicker" style="font-size:40px;background:${c.ink};color:${c.primary}">${esc(kicker)}</span></div>
  <div class="abs" data-fit-box="1" style="left:${S.left}px;top:${S.top + 130}px;width:${tw}px;height:640px"><div class="display" data-fit data-min="84" data-text="hook" style="font-size:150px;color:${c.ink};width:${tw}px">${slamWords(tl, i.shots.hook, 0.0, 0.085)}</div></div>
  <div class="abs ${peek}" style="left:${(W - peekW) / 2 + 40}px;top:1120px;width:${peekW}px;height:${r1(peekG.visibleH)}px">${cardHtml({ s: peekS, x: 0, y: 0, w: peekW, h: peekG.visibleH, radius: Math.round(k.radius * 2.6) })}</div>
  ${hookSticker ? `<div class="abs ${hookStick}" style="left:0;top:0">${stickerHtml(k, hookSticker, { x: 860, y: 1080, size: 210, rot: 12 })}</div>` : ""}
</div>`;
  cues.push({ t: 0.02, kind: "pop" }, { t: 0.3, kind: "whoosh" });

  // ---- steps (light background): badge + headline on top, the screen card large, camera zoom, tap, captions.
  const cardW = 720;
  const cardX = (W - cardW) / 2;
  const cardY = 720;
  const radius = Math.round(k.radius * 2.8);
  const visH = (s: ScreenAsset) => Math.min(screenGeom(s, cardW).visibleH, H - cardY + 120);
  const cardH = Math.max(...steps.map((st) => visH(screenOf(i, st.screen))), 900);
  const stepStart = (j: number) => HOOK + j * STEP;
  const rise = tl.track([
    [HOOK - 0.2, tf(1, 0, 760)],
    [HOOK + 0.55, tf(1), EASE.out],
  ]);
  // Camera: per step zoom into the focus and back out before the next screen.
  const camStops: Array<[number, string, string?]> = [[0, "transform:translate3d(0,0,0) scale(1)"]];
  const screensHtml: string[] = [];
  const taps: string[] = [];
  const heads: string[] = [];
  const caps: string[] = [];
  steps.forEach((st, j) => {
    const s0 = stepStart(j);
    const s = screenOf(i, st.screen);
    // Screen push (iOS-like) inside the card.
    const inT = j === 0 ? null : s0 - 0.12;
    const outT = j < n - 1 ? stepStart(j + 1) - 0.12 : null;
    const scr = tl.track([
      ...(inT === null ? ([[0, tf(1)]] as Array<[number, string, string?]>) : ([[inT, tf(1, cardW * 1.02)], [inT + 0.55, tf(1), EASE.inOut]] as Array<[number, string, string?]>)),
      ...(outT === null ? [] : ([[outT, tf(1)], [outT + 0.55, tf(1, -cardW * 0.32)], [outT + 0.56, tf(0, -cardW * 0.32)]] as Array<[number, string, string?]>)),
    ]);
    screensHtml.push(`<div class="abs ${scr}" style="inset:0;z-index:${j + 1};background:#fff;box-shadow:-24px 0 50px rgba(0,0,0,.14)">${screenImg(s, cardW)}</div>`);
    if (j > 0) cues.push({ t: s0 - 0.12, kind: "whoosh" });
    // Zoom: the camera moves inside the card (the frame and the headline stay put).
    if (st.focus) {
      const f = onCard(regionCenter(st.focus), s, cardW);
      const z = Math.max(1.12, Math.min(2.1, 0.5 / Math.max(0.1, st.focus.w)));
      const viewH = Math.min(cardH, H - cardY);
      // The clear area: between the caption and the platform's bottom UI.
      const { tx, ty } = innerZoom({ cardW, viewH, contentH: screenGeom(s, cardW).visibleH, focus: f, target: { x: cardW / 2, y: (S.bottom - cardY) * 0.55 }, z });
      camStops.push([s0 + 0.75, "transform:translate3d(0,0,0) scale(1)"], [s0 + 1.65, `transform:translate3d(${r1(tx)}px,${r1(ty)}px,0) scale(${z.toFixed(3)})`, EASE.inOut], [s0 + STEP - 0.42, `transform:translate3d(${r1(tx)}px,${r1(ty)}px,0) scale(${z.toFixed(3)})`], [s0 + STEP - 0.02, "transform:translate3d(0,0,0) scale(1)", EASE.inOut]);
    }
    // Tap: a finger dot presses and a ring ripples out.
    if (st.tap) {
      const p = onCard(st.tap, s, cardW);
      const tt = s0 + (st.focus ? 1.85 : 1.1);
      const finger = tl.track([[tt - 0.45, tf(0, 30, 40, 1.15)], [tt - 0.15, tf(0.95, 0, 0, 1.15), EASE.out], [tt, tf(0.95, 0, 0, 0.86), EASE.in], [tt + 0.18, tf(0.95, 0, 0, 1), EASE.out], [tt + 0.6, tf(0, 0, 0, 1)]]);
      const ring = tl.track([[tt, tf(0.9, 0, 0, 0.3)], [tt + 0.55, tf(0, 0, 0, 1.9), EASE.out]]);
      taps.push(`<div class="dot ${ring}" style="left:${r1(p.x - 60)}px;top:${r1(p.y - 60)}px;width:120px;height:120px;border:7px solid ${c.primary};z-index:20"></div><div class="dot ${finger}" style="left:${r1(p.x - 42)}px;top:${r1(p.y - 42)}px;width:84px;height:84px;background:rgba(255,255,255,.92);box-shadow:0 10px 26px rgba(0,0,0,.28),0 0 0 3px rgba(0,0,0,.06);z-index:21"></div>`);
      cues.push({ t: tt, kind: "tap" });
    }
    // Headline with the step badge.
    const hIn = s0 + (j === 0 ? 0.0 : 0.05);
    const hOut = j < n - 1 ? stepStart(j + 1) - 0.18 : T - END + 0.1;
    const head = tl.track([[hIn, tf(0, 0, 46)], [hIn + 0.5, tf(1), EASE.out], [hOut, tf(1)], [hOut + 0.3, tf(0, 0, -30), EASE.in]]);
    const badge = tl.track([[hIn + 0.05, tf(0, 0, 0, 0.4, -20)], [hIn + 0.45, tf(1, 0, 0, 1, 0), EASE.pop]]);
    const badgeText = mode === "new" ? L.isNew : String(j + 1);
    const stick = pickSticker(k, st.sticker);
    heads.push(`<div class="abs ${head}" style="left:${S.left}px;top:${S.top}px;width:${tw}px;height:${cardY - S.top - 40}px">
  <div class="abs ${badge}" style="left:0;top:0"><span class="chip" data-text="badge" style="font-size:${mode === "new" ? 40 : 46}px;background:${c.primary};color:${c.onPrimary};${mode === "new" ? "" : "min-width:1.9em;justify-content:center"}">${esc(badgeText)}</span></div>
  <div class="abs" data-fit-box="1" style="left:0;top:96px;width:${stick ? tw - 150 : tw}px;height:${cardY - S.top - 300}px"><div class="display" data-fit data-min="56" data-text="headline" style="font-size:96px;color:${c.ink};width:${stick ? tw - 150 : tw}px">${wordSpans(st.headline)}</div></div>
  ${stick ? `<div class="abs ${bob(tl, T, 9, 1.8, j * 0.3, 3)}" style="left:0;top:0">${stickerHtml(k, stick, { x: tw - 60, y: 120, size: 170, rot: 10 })}</div>` : ""}
</div>`);
    if (st.caption) caps.push(captionHtml(tl, c, { text: st.caption, t0: s0 + 0.35, t1: (j < n - 1 ? stepStart(j + 1) : T - END) - 0.05, y: cardY - 150, px: 46 }));
  });
  camStops.push([T, "transform:translate3d(0,0,0) scale(1)"]);
  const cam = tl.track(camStops);
  const stepsReveal = circleReveal(tl, { x: W / 2, y: 1500, t0: HOOK - 0.45, dur: 0.75, maxR: 2300 });
  cues.push({ t: HOOK - 0.4, kind: "whoosh" });
  const stepsLayer = `<div class="abs ${stepsReveal}" style="inset:0;background:${c.bg}">
  <div class="abs" style="right:-260px;top:-200px;width:760px;height:760px;border-radius:50%;background:${c.primary};opacity:.16"></div>
  <div class="abs ${rise}" style="left:0;top:0;width:${W}px;height:${H}px">
    <div class="card" style="left:${cardX}px;top:${cardY}px;width:${cardW}px;height:${cardH}px;border-radius:${radius}px">
      <div class="abs ${cam}" style="left:0;top:0;width:${cardW}px;height:${cardH}px;transform-origin:0 0">${screensHtml.join("")}${taps.join("")}</div>
    </div>
  </div>
  ${heads.join("\n")}
  ${caps.join("\n")}
</div>`;

  // ---- end card (brand colour): the real icon, name, line, button, the trail leading to the icon.
  const e0 = T - END;
  const endReveal = circleReveal(tl, { x: W / 2, y: 820, t0: e0 - 0.1, dur: 0.7, maxR: 2300 });
  cues.push({ t: e0 - 0.05, kind: "whoosh" }, { t: e0 + 0.4, kind: "pop" });
  const endLayer = endCard(tl, i, c, { t0: e0, W, H, iconY: 760, compact: false });
  return {
    kind: "video",
    ratio: "9:16",
    W,
    H,
    seconds: r1(T),
    html: docHtml({ W, H, lang: k.language, kit: { ...k, background: c.primary }, timeline: tl, css: baseCss(k, c), body: `${hookLayer}${stepsLayer}<div class="abs ${endReveal}" style="inset:0">${endLayer}</div>` }),
    cues,
    sampleTimes: [0.9, HOOK + 1.9, ...steps.slice(1).map((_, j) => stepStart(j + 1) + 1.9), T - 0.6].map((t) => r1(Math.min(T - 0.05, t))),
  };
}

/** The end card: icon pops, the trail runs into it, name, line, button. Shared by every video template. */
export function endCard(tl: Timeline, i: RenderInput, c: Colors, o: { t0: number; W: number; H: number; iconY: number; compact: boolean }): string {
  const k = i.kit;
  const L = labels(k.language);
  const ap = (d: number) => tl.track([[o.t0 + d, tf(0, 0, 40)], [o.t0 + d + 0.5, tf(1), EASE.out]]);
  const iconPop = tl.track([[o.t0 + 0.3, tf(0, 0, 0, 0.3, -14)], [o.t0 + 0.85, tf(1, 0, 0, 1, 0), EASE.pop]]);
  const size = o.compact ? 230 : 300;
  const icon = iconHtml(k, { x: o.W / 2, y: o.iconY, size });
  const nameY = icon ? o.iconY + size / 2 + 50 : o.iconY - 40;
  const s1 = pickSticker(k, "pin", "sparkles", "party");
  const s2 = pickSticker(k, "party", "fire", "sparkles");
  const trail = trailPoints([{ x: -60, y: o.iconY - 560 }, { x: 170, y: o.iconY - 470 }, { x: 250, y: o.iconY - 250 }, { x: o.W / 2 - size / 2 - 50, y: o.iconY - 60 }], 12);
  return `<div class="abs" style="inset:0;background:${c.primary}">
  <div class="abs" style="left:${o.W / 2 - 700}px;top:${o.iconY - 700}px;width:1400px;height:1400px;border-radius:50%;background:radial-gradient(closest-side,${c.primarySoft},${c.primary})"></div>
  ${trailHtml(trail, { r: 11, color: c.ink, tl, t0: o.t0 + 0.05, t1: o.t0 + 0.6 })}
  ${icon ? `<div class="abs ${iconPop}" style="left:0;top:0;width:${o.W}px;height:${o.H}px">${icon}</div>` : ""}
  ${s1 ? `<div class="abs ${ap(0.7)}" style="left:0;top:0"><div class="${bob(tl, tl.T, 8, 1.6, 0.2, 4)}">${stickerHtml(k, s1, { x: o.W / 2 + size / 2 + 20, y: o.iconY - size / 2 + 10, size: 150, rot: 14 })}</div></div>` : ""}
  ${s2 && s2 !== s1 ? `<div class="abs ${ap(0.8)}" style="left:0;top:0"><div class="${bob(tl, tl.T, 7, 1.9, 0.6, 3)}">${stickerHtml(k, s2, { x: o.W / 2 - size / 2 - 10, y: o.iconY + size / 2 - 10, size: 120, rot: -12 })}</div></div>` : ""}
  <div class="abs ${ap(0.5)}" style="left:0;width:${o.W}px;top:${nameY}px;text-align:center"><div class="display" data-text="name" style="font-size:${o.compact ? 110 : 132}px;color:${c.onPrimary}">${esc(k.appName)}</div></div>
  <div class="abs ${ap(0.62)}" style="left:150px;width:${o.W - 300}px;top:${nameY + (o.compact ? 132 : 158)}px;text-align:center"><div class="body" data-text="endline" style="font-size:${o.compact ? 42 : 48}px;line-height:1.15;color:${c.onPrimary};opacity:.82;text-wrap:balance">${esc(i.shots.endLine)}</div></div>
  <div class="abs ${ap(0.78)}" style="left:0;width:${o.W}px;top:${nameY + (o.compact ? 270 : 310)}px;text-align:center">${buttonHtml(k, i.shots.cta || L.linkInBio, o.compact ? 44 : 52)}</div>
</div>`;
}

// ---------------------------------------------------------------- slides (carousel)

/** Cover → one slide per step → end slide, as one panorama (the trail runs across slides). */
export function stepsSlides(i: RenderInput, ratio: Ratio, mode: Mode = "steps"): SlideComposition {
  const { W, H } = SIZES[ratio];
  const k = i.kit;
  const c = colors(k);
  const L = labels(k.language);
  const steps = i.shots.steps.slice(0, 6);
  const count = steps.length + 2;
  const PW = W * count;
  const sq = ratio === "1:1";
  const M = 84;
  const radius = Math.round(k.radius * (sq ? 2 : 2.4));
  const slides: string[] = [];

  // Backgrounds: brand colour on cover and end, light in between.
  const bg = (j: number) => (j === 0 || j === count - 1 ? c.primary : c.bg);
  for (let j = 0; j < count; j++) slides.push(`<div class="abs" style="left:${j * W}px;top:0;width:${W}px;height:${H}px;background:${bg(j)};overflow:hidden">${j > 0 && j < count - 1 ? `<div class="abs" style="right:-240px;top:-220px;width:620px;height:620px;border-radius:50%;background:${c.primary};opacity:.14"></div>` : ""}</div>`);

  // The trail: one dotted path through every slide (swiping follows it), behind the screens;
  // ink on the brand colour, brand colour on light slides.
  const via: Array<{ x: number; y: number }> = [{ x: -60, y: H * 0.97 }];
  for (let j = 0; j < count; j++) via.push({ x: j * W + W * 0.5, y: H * (j === 0 ? 0.985 : j === count - 1 ? 0.9 : j % 2 ? 0.965 : 0.93) }, { x: (j + 1) * W + 10, y: H * (j % 2 ? 0.95 : 0.975) });
  via.pop();
  const trail = trailPoints(via, count * 9);
  const trailDots = trail
    .map((p) => {
      const slide = Math.floor(p.x / W);
      const onBrand = slide === 0 || slide === count - 1;
      const r = sq ? 9 : 11;
      return `<div class="dot" style="left:${r1(p.x - r)}px;top:${r1(p.y - r)}px;width:${r * 2}px;height:${r * 2}px;background:${onBrand ? c.ink : c.primary}"></div>`;
    })
    .join("");

  // Cover.
  const kicker = i.shots.kicker ?? (mode === "new" ? `${L.isNew}${i.shots.version ? ` · ${L.version} ${i.shots.version}` : ""}` : L.howItWorks);
  const coverS = screenOf(i, steps[0]?.screen ?? 0);
  const coverCardW = sq ? 430 : 520;
  const coverG = screenGeom(coverS, coverCardW);
  const coverSticker = pickSticker(k, steps[0]?.sticker, "sparkles", "fire");
  const cover = `
  <div class="abs" style="left:${M}px;top:${sq ? 80 : 100}px"><span class="chip" data-text="kicker" style="font-size:${sq ? 34 : 38}px;background:${c.ink};color:${c.primary}">${esc(kicker)}</span></div>
  <div class="abs" data-fit-box="1" style="left:${M}px;top:${sq ? 170 : 200}px;width:${sq ? 500 : W - 2 * M}px;height:${sq ? 560 : 470}px"><div class="display" data-fit data-min="56" data-text="hook" style="font-size:${sq ? 96 : 128}px;color:${c.ink};width:${sq ? 500 : W - 2 * M}px">${wordSpans(i.shots.hook)}</div></div>
  ${cardHtml({ s: coverS, x: sq ? 640 : W - coverCardW - 40, y: sq ? 300 : 700, w: coverCardW, h: coverG.visibleH, radius, style: "transform:rotate(6deg);transform-origin:0 0" })}
  ${coverSticker ? stickerHtml(k, coverSticker, { x: sq ? 560 : 300, y: sq ? 860 : 1090, size: sq ? 170 : 210, rot: -12 }) : ""}
  <div class="abs" style="left:${M}px;top:${H - (sq ? 110 : 130)}px"><span class="chip" data-text="swipe" style="font-size:${sq ? 30 : 34}px;background:rgba(255,255,255,.85);color:${c.ink}">${esc(L.swipe)} →</span></div>`;

  // Steps: badge, headline and sub flow in a column; the screen large, bleeding off the bottom;
  // the detail that matters lifted off it and enlarged.
  const stepSlides = steps
    .map((st, j) => {
      const x0 = (j + 1) * W;
      const s = screenOf(i, st.screen);
      const cardW = sq ? 430 : 600;
      const g = screenGeom(s, cardW);
      const stick = pickSticker(k, st.sticker);
      const cardX = sq ? W - cardW - 70 : (W - cardW) / 2;
      const cardY = sq ? 250 : 540;
      const textW = sq ? W - cardW - 70 - M - 30 : W - 2 * M - (stick ? 170 : 0);
      const badge = mode === "new" ? L.isNew : String(j + 1);
      let pop = "";
      if (st.focus) {
        const r = popoutHtml({ s, focus: st.focus, cardX, cardY, cardW, maxW: sq ? cardW + 140 : W - 2 * 56, minX: sq ? cardX - 110 : 56, maxX: W - (sq ? 40 : 56), minY: cardY + 60, maxY: H - 40, ring: c.primary, radius: Math.round(k.radius * 1.4), zoom: 1.6 });
        pop = r.html;
      }
      return `<div class="abs" style="left:${x0}px;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:${M}px;top:${sq ? 80 : 92}px;width:${textW}px;display:flex;flex-direction:column;align-items:flex-start;gap:${sq ? 22 : 24}px">
    <span class="chip" data-text="badge" style="font-size:${sq ? 36 : 42}px;background:${c.primary};color:${c.onPrimary};${mode === "new" ? "" : "min-width:1.9em;justify-content:center"}">${esc(badge)}</span>
    <div class="display" data-fit data-min="44" data-maxh="${sq ? 330 : 190}" data-text="headline" style="font-size:${sq ? 72 : 86}px;color:${c.ink};width:${textW}px">${wordSpans(st.headline)}</div>
    ${st.caption ? `<div class="body" data-fit data-min="26" data-maxh="${sq ? 230 : 92}" data-text="sub" style="font-size:${sq ? 34 : 36}px;color:${c.inkSoft};width:${textW}px;text-wrap:pretty">${esc(st.caption)}</div>` : ""}
  </div>
  ${cardHtml({ s, x: cardX, y: cardY, w: cardW, h: Math.min(g.visibleH, H - cardY + 200), radius })}
  ${pop}
  ${stick ? stickerHtml(k, stick, sq ? { x: M + 80, y: H - 170, size: 150, rot: -10 } : { x: W - M - 70, y: 150, size: 170, rot: 10 }) : ""}
</div>`;
    })
    .join("");

  // End.
  const xe = (count - 1) * W;
  const iconY = sq ? H * 0.3 : H * 0.33;
  const isz = sq ? 240 : 280;
  const icon = iconHtml(k, { x: W / 2, y: iconY, size: isz });
  const nameY = icon ? iconY + isz / 2 + 40 : iconY - 60;
  const s1 = pickSticker(k, "pin", "sparkles");
  const end = `<div class="abs" style="left:${xe}px;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:${W / 2 - 600}px;top:${iconY - 600}px;width:1200px;height:1200px;border-radius:50%;background:radial-gradient(closest-side,${c.primarySoft},${c.primary})"></div>
  ${icon}
  ${s1 ? stickerHtml(k, s1, { x: W / 2 + isz / 2 + 10, y: iconY - isz / 2, size: 140, rot: 14 }) : ""}
  <div class="abs" style="left:0;width:${W}px;top:${nameY}px;text-align:center"><div class="display" data-text="name" style="font-size:${sq ? 100 : 120}px;color:${c.onPrimary}">${esc(k.appName)}</div></div>
  <div class="abs" style="left:${M}px;width:${W - 2 * M}px;top:${nameY + (sq ? 118 : 142)}px;text-align:center"><div class="body" data-text="endline" style="font-size:${sq ? 40 : 46}px;color:${c.onPrimary};opacity:.82">${esc(i.shots.endLine)}</div></div>
  <div class="abs" style="left:0;width:${W}px;top:${nameY + (sq ? 210 : 250)}px;text-align:center">${buttonHtml(k, i.shots.cta || L.linkInBio, sq ? 42 : 48)}</div>
</div>`;

  const body = `<div class="abs" style="left:0;top:0;width:${PW}px;height:${H}px">${slides.join("")}${trailDots}<div class="abs" style="left:0;top:0">${cover}</div>${stepSlides}${end}</div>`;
  return { kind: "slides", ratio, W, H, count, html: docHtml({ W: PW, H, lang: k.language, kit: k, css: baseCss(k, c), body }) };
}
