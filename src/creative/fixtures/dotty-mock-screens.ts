import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { fileUri, withBrowser } from "../motion/engine";
import type { ScreenAsset } from "../templates/types";

/**
 * MOCK captures of Dotty's key screens, in German — for tests and sample
 * renders on a machine without the iPhone Simulator (this one). Built from
 * Dotty's own repo: its design tokens (src/theme/tokens.ts), its Nunito font
 * files, its 3D icons and its bundled demo pictures (src/assets/welcome —
 * the pictures the app's own demo recap uses). They imitate what
 * `xcrun simctl io screenshot` returns (1170×2532, status bar included); a
 * real run uses real captures instead (capture.ts). Never used for real posts.
 */

const W = 390;
const H = 844;

type Asset = (p: string) => string;

function css(a: Asset): string {
  return `
@font-face{font-family:N;src:url("${a("assets/fonts/Nunito-SemiBold.ttf")}");font-weight:600}
@font-face{font-family:N;src:url("${a("assets/fonts/Nunito-Bold.ttf")}");font-weight:700}
@font-face{font-family:N;src:url("${a("assets/fonts/Nunito-ExtraBold.ttf")}");font-weight:800}
@font-face{font-family:N;src:url("${a("assets/fonts/Nunito-Black.ttf")}");font-weight:900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#fff;font-family:N;color:#222;font-weight:600;-webkit-font-smoothing:antialiased}
.abs{position:absolute}
.sb{position:absolute;left:0;right:0;top:0;height:54px;display:flex;align-items:center;justify-content:space-between;padding:14px 30px 0 40px;font-weight:700;font-size:17px;z-index:50}
.sb .r{display:flex;gap:6px;align-items:center}
.bat{width:26px;height:12px;border:1.6px solid currentColor;border-radius:4px;position:relative;opacity:.9}.bat:after{content:"";position:absolute;inset:1.5px;background:currentColor;border-radius:1.5px}
.seg{display:flex;background:#f2f2f2;border-radius:999px;padding:4px}
.seg div{flex:1;text-align:center;padding:8px 0;border-radius:999px;font-weight:800;font-size:15px;color:#6a6a6a}
.seg .on{background:#fff;color:#222;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.b3d{display:flex;align-items:center;justify-content:center;gap:10px;height:56px;border-radius:999px;background:linear-gradient(180deg,#454545,#262626 60%,#161616);color:#fff;font-weight:800;font-size:17px;box-shadow:0 5px 0 #0b0b0b,0 10px 18px rgba(0,0,0,.18)}
.av{border-radius:50%;object-fit:cover;border:2.5px solid #fff;box-shadow:0 3px 8px rgba(0,0,0,.18)}
.meta{font-size:13px;color:#6a6a6a;font-weight:600}
.h2{font-weight:800;font-size:19px}
.hero{font-weight:900;font-size:30px;line-height:36px}
.tab{position:absolute;left:0;right:0;bottom:0;height:84px;background:#fff;border-top:1px solid #ebebeb;display:flex;justify-content:space-around;padding-top:10px}
.tab img{width:30px;height:30px}
.tab div{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;font-weight:800;color:#b0b0b0}.tab .on{color:#222}
.home{position:absolute;bottom:8px;left:50%;width:134px;height:5px;margin-left:-67px;border-radius:3px;background:#222}
`;
}

const statusBar = (dark = false) => `<div class="sb" style="color:${dark ? "#fff" : "#222"}"><span>9:41</span><span class="r"><svg width="18" height="12" viewBox="0 0 18 12"><path fill="currentColor" d="M1 9h2.5v3H1zM5.5 6.5H8V12H5.5zM10 4h2.5v8H10zM14.5 1H17v11h-2.5z"/></svg><svg width="16" height="12" viewBox="0 0 16 12"><path fill="currentColor" d="M8 2.6c2.3 0 4.4.9 6 2.4l1.1-1.1A10 10 0 0 0 8 1 10 10 0 0 0 .9 3.9L2 5c1.6-1.5 3.7-2.4 6-2.4Zm0 3.2c1.4 0 2.7.5 3.7 1.4l1.1-1.1A7 7 0 0 0 8 4.2a7 7 0 0 0-4.8 1.9l1.1 1.1c1-.9 2.3-1.4 3.7-1.4Zm0 3.2c.6 0 1.1.2 1.5.6L8 11.1 6.5 9.6c.4-.4.9-.6 1.5-.6Z"/></svg><span class="bat"></span></span></div>`;

function mapScreen(a: Asset): string {
  const pin = (x: number, y: number, img: string, av: string, me = false, r = 0) =>
    `<div class="abs" style="left:${x}px;top:${y}px;transform:rotate(${r}deg)"><div style="width:74px;height:98px;border-radius:14px;background:${me ? "#f5c228" : "#fff"};padding:4px;box-shadow:0 3px 5px rgba(0,0,0,.32)"><img src="${a(img)}" style="width:66px;height:90px;border-radius:10px;object-fit:cover"></div><img class="av abs" src="${a(av)}" style="width:32px;height:32px;left:-10px;bottom:-10px"></div>`;
  return `${statusBar()}<img class="abs" src="${a("src/assets/welcome/map-bg.jpg")}" style="left:-40px;top:0;width:470px;height:${H}px;object-fit:cover">
<div class="abs" style="left:16px;right:16px;top:58px;display:flex;gap:10px;align-items:center"><div class="seg" style="flex:1;box-shadow:0 6px 16px rgba(0,0,0,.12)"><div class="on">Freunde</div><div>Alle</div></div><img class="av" src="${a("src/assets/welcome/avatar-luca.jpg")}" style="width:44px;height:44px"></div>
${pin(52, 210, "src/assets/welcome/pizza.jpg", "src/assets/welcome/avatar-mia.jpg", false, -6)}
${pin(236, 280, "src/assets/welcome/hoops.jpg", "src/assets/welcome/avatar-jonas.jpg", false, 5)}
${pin(120, 430, "src/assets/welcome/park.jpg", "src/assets/welcome/avatar-luca.jpg", true, -3)}
${pin(262, 500, "src/assets/welcome/stadium.jpg", "src/assets/welcome/avatar-emma.jpg", false, 7)}
<div class="abs" style="left:150px;top:395px;background:#fff;border-radius:16px;padding:8px 12px;box-shadow:0 6px 14px rgba(0,0,0,.16);font-size:14px;font-weight:800;white-space:nowrap">luigi ist hier 📍<div class="meta">Shiso Burger · Mitte</div></div>
<div class="abs" style="left:24px;right:24px;bottom:110px;display:flex;justify-content:center"><div class="b3d" style="width:220px"><img src="${a("src/assets/3d/camera@3x.png")}" style="width:30px;height:30px">Moment teilen</div></div>
<div class="tab"><div class="on"><img src="${a("src/assets/3d/map@3x.png")}">Karte</div><div><img src="${a("src/assets/3d/feed@3x.png")}" style="opacity:.55">Feed</div><div><img src="${a("src/assets/3d/chat@3x.png")}" style="opacity:.55">Chats</div><div><img src="${a("src/assets/3d/trophy@3x.png")}" style="opacity:.55">Rangliste</div></div><div class="home"></div>`;
}

function postScreen(a: Asset): string {
  return `${statusBar()}<div class="abs" style="left:20px;right:20px;top:62px;display:flex;align-items:center;justify-content:space-between"><div class="h2">Dein Moment</div><div style="width:36px;height:36px;border-radius:50%;background:#f2f2f2;display:flex;align-items:center;justify-content:center;font-weight:900">✕</div></div>
<div class="abs" style="left:20px;right:20px;top:112px;height:467px;border-radius:20px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,.18)"><img src="${a("src/assets/welcome/pizza.jpg")}" style="width:100%;height:100%;object-fit:cover"><div class="abs" style="left:12px;top:12px;background:rgba(255,255,255,.92);border-radius:999px;padding:6px 12px;font-weight:800;font-size:13px">gerade eben</div></div>
<div class="abs" style="left:20px;right:20px;top:596px;background:#fff;border-radius:18px;padding:12px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 6px 10px rgba(0,0,0,.08);border:1px solid #ebebeb"><div style="width:48px;height:48px;border-radius:14px;background:#f7f7f7;display:flex;align-items:center;justify-content:center"><img src="${a("src/assets/3d/restaurant@3x.png")}" style="width:36px;height:36px"></div><div style="flex:1"><div style="font-weight:800;font-size:16px">Da Nino</div><div class="meta">Hier bei dir · bis 100 m</div></div><div style="background:#ffe7a3;border-radius:999px;padding:6px 10px;font-weight:900;font-size:13px">12 m</div></div>
<div class="abs" style="left:20px;right:20px;top:676px;background:#f2f2f2;border-radius:16px;padding:12px 14px;font-size:15px">Margherita-Abend mit den Jungs 🍕</div>
<div class="abs" style="left:20px;right:20px;bottom:40px"><div class="b3d">Mit Freunden teilen</div></div><div class="home"></div>`;
}

function feedScreen(a: Asset): string {
  const card = (top: number, av: string, who: string, place: string, when: string, img: string, live = false, fire = 0) =>
    `<div class="abs" style="left:20px;right:20px;top:${top}px;display:flex;gap:12px;padding:10px;border-radius:18px;background:#fff;box-shadow:0 6px 10px rgba(0,0,0,.08)"><div style="position:relative"><img src="${a(img)}" style="width:96px;height:128px;border-radius:12px;object-fit:cover;display:block"><img class="av abs" src="${a(av)}" style="width:34px;height:34px;left:-8px;bottom:-8px"></div><div style="flex:1;padding-top:4px"><div style="font-weight:800;font-size:16px">${who} ist hier 📍</div><div style="font-weight:700;font-size:14px;margin-top:4px">${place}</div><div class="meta" style="margin-top:6px;display:flex;align-items:center;gap:6px">${live ? '<span style="width:10px;height:10px;border-radius:50%;background:#22b455;box-shadow:0 0 0 3px rgba(34,180,85,.18)"></span>' : ""}${when}</div>${fire ? `<div style="margin-top:12px;display:inline-flex;align-items:center;gap:4px;background:#f2f2f2;border-radius:999px;padding:4px 10px 4px 6px;font-weight:800;font-size:13px"><img src="${a("src/assets/3d/fire@3x.png")}" style="width:20px;height:20px">${fire}</div>` : ""}</div></div>`;
  return `${statusBar()}<div class="abs" style="left:20px;top:62px" ><div class="hero">Feed</div></div>
<div class="abs" style="left:20px;right:20px;top:112px"><div class="seg"><div class="on">Freunde</div><div>Alle</div></div></div>
<div class="abs" style="left:20px;right:20px;top:170px;display:flex;align-items:center;gap:10px"><span class="meta" style="font-weight:800">Gerade jetzt</span><span style="flex:1;height:1px;background:#ebebeb"></span></div>
${card(198, "src/assets/welcome/avatar-mia.jpg", "mia", "Eisdiele Venezia · Mitte", "gerade eben", "src/assets/welcome/park.jpg", true, 4)}
${card(356, "src/assets/welcome/avatar-jonas.jpg", "jonas", "Mauerpark Courts", "vor 8 Min.", "src/assets/welcome/hoops.jpg", true, 7)}
<div class="abs" style="left:20px;right:20px;top:516px;display:flex;align-items:center;gap:10px"><span class="meta" style="font-weight:800">Früher heute</span><span style="flex:1;height:1px;background:#ebebeb"></span></div>
${card(544, "src/assets/welcome/avatar-emma.jpg", "emma", "Alte Försterei", "vor 2 Std.", "src/assets/welcome/stadium.jpg", false, 12)}
<div class="tab"><div><img src="${a("src/assets/3d/map@3x.png")}" style="opacity:.55">Karte</div><div class="on"><img src="${a("src/assets/3d/feed@3x.png")}">Feed</div><div><img src="${a("src/assets/3d/chat@3x.png")}" style="opacity:.55">Chats</div><div><img src="${a("src/assets/3d/trophy@3x.png")}" style="opacity:.55">Rangliste</div></div><div class="home"></div>`;
}

function recapScreen(a: Asset): string {
  const row = (n: number, av: string, who: string, pts: string, medal: string | null, me = false) =>
    `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:16px;background:${me ? "#ffe7a3" : "#fff"};${me ? "" : "border:1px solid #ebebeb"}">${medal ? `<img src="${a(medal)}" style="width:34px;height:34px">` : `<span style="width:34px;text-align:center;font-weight:900;color:#b0b0b0">${n}</span>`}<img class="av" src="${a(av)}" style="width:40px;height:40px"><span style="flex:1;font-weight:800;font-size:16px">${who}</span><span style="font-weight:900">${pts}</span></div>`;
  return `${statusBar(true)}<img class="abs" src="${a("src/assets/welcome/burst.jpg")}" style="left:0;top:0;width:${W}px;height:420px;object-fit:cover">
<div class="abs" style="left:0;right:0;top:70px;text-align:center"><div style="font-weight:800;font-size:14px;letter-spacing:.06em">DEIN WOCHENRÜCKBLICK</div></div>
<div class="abs" style="left:0;right:0;top:110px;display:flex;justify-content:center"><img src="${a("src/assets/3d/trophy@3x.png")}" style="width:120px;height:120px;filter:drop-shadow(0 10px 14px rgba(0,0,0,.2))"></div>
<div class="abs" style="left:24px;right:24px;top:246px;text-align:center"><div class="hero">Du hast die Woche gewonnen 🎉</div><div class="meta" style="margin-top:8px;color:#222;opacity:.75">14 Momente · 9 Orte</div></div>
<div class="abs" style="left:20px;right:20px;top:440px;display:flex;flex-direction:column;gap:10px">${row(1, "src/assets/welcome/avatar-luca.jpg", "Du", "1.240", "src/assets/3d/medal1@3x.png", true)}${row(2, "src/assets/welcome/avatar-mia.jpg", "mia", "1.105", "src/assets/3d/medal2@3x.png")}${row(3, "src/assets/welcome/avatar-jonas.jpg", "jonas", "980", "src/assets/3d/medal3@3x.png")}${row(4, "src/assets/welcome/avatar-emma.jpg", "emma", "710", null)}</div>
<div class="abs" style="left:20px;right:20px;bottom:40px"><div class="b3d">Rückblick teilen</div></div><div class="home"></div>`;
}

export const DOTTY_MOCKS = [
  { name: "karte", build: mapScreen, shows: "Die Karte: wo deine Freunde gerade sind" },
  { name: "moment", build: postScreen, shows: "Einen Moment teilen — nur wo du wirklich bist" },
  { name: "feed", build: feedScreen, shows: "Feed: wer gerade wo ist" },
  { name: "rueckblick", build: recapScreen, shows: "Wochenrückblick mit Rangliste" },
] as const;

/** Renders the mock screens (1170×2532 PNG) into `dir`. */
export async function renderDottyMocks(dottyRepo: string, dir: string, browser?: Browser): Promise<ScreenAsset[]> {
  mkdirSync(dir, { recursive: true });
  const a: Asset = (p) => fileUri(join(dottyRepo, p)) ?? "";
  return withBrowser(async (b) => {
    const out: ScreenAsset[] = [];
    for (const m of DOTTY_MOCKS) {
      const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 3 });
      await page.setContent(`<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css(a)}</style></head><body>${m.build(a)}</body></html>`, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const file = join(dir, `${m.name}.png`);
      await page.screenshot({ path: file });
      await page.close();
      out.push({ file, width: W * 3, height: H * 3, language: "de", source: "mock", name: m.name, statusBar: 54 / H });
    }
    return out;
  }, browser);
}
