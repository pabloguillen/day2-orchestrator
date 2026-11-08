import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { fileUri, withBrowser } from "../motion/engine";
import type { ScreenAsset } from "../templates/types";
import type { DemoCast } from "../demo-cast/schema";

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

/** What the mock screens show: Dotty's own demo content by default, or a demo cast (names, pictures, captions, places, ranking). */
type Fill = {
  me: { name: string; av: string };
  pins: Array<{ img: string; av: string }>;
  here: { who: string; place: string };
  post: { img: string; place: string; caption: string };
  feed: Array<{ av: string; who: string; place: string; when: string; img: string; live: boolean; fire: number }>;
  rank: Array<{ av: string; who: string; pts: string }>;
};
const DEFAULT_FILL: Fill = {
  me: { name: "Du", av: "src/assets/welcome/avatar-luca.jpg" },
  pins: [
    { img: "src/assets/welcome/pizza.jpg", av: "src/assets/welcome/avatar-mia.jpg" },
    { img: "src/assets/welcome/hoops.jpg", av: "src/assets/welcome/avatar-jonas.jpg" },
    { img: "src/assets/welcome/park.jpg", av: "src/assets/welcome/avatar-luca.jpg" },
    { img: "src/assets/welcome/stadium.jpg", av: "src/assets/welcome/avatar-emma.jpg" },
  ],
  here: { who: "luigi", place: "Shiso Burger · Mitte" },
  post: { img: "src/assets/welcome/pizza.jpg", place: "Da Nino", caption: "Margherita-Abend mit den Jungs 🍕" },
  feed: [
    { av: "src/assets/welcome/avatar-mia.jpg", who: "mia", place: "Eisdiele Venezia · Mitte", when: "gerade eben", img: "src/assets/welcome/park.jpg", live: true, fire: 4 },
    { av: "src/assets/welcome/avatar-jonas.jpg", who: "jonas", place: "Mauerpark Courts", when: "vor 8 Min.", img: "src/assets/welcome/hoops.jpg", live: true, fire: 7 },
    { av: "src/assets/welcome/avatar-emma.jpg", who: "emma", place: "Alte Försterei", when: "vor 2 Std.", img: "src/assets/welcome/stadium.jpg", live: false, fire: 12 },
  ],
  rank: [
    { av: "src/assets/welcome/avatar-luca.jpg", who: "Du", pts: "1.240" },
    { av: "src/assets/welcome/avatar-mia.jpg", who: "mia", pts: "1.105" },
    { av: "src/assets/welcome/avatar-jonas.jpg", who: "jonas", pts: "980" },
    { av: "src/assets/welcome/avatar-emma.jpg", who: "emma", pts: "710" },
  ],
};

const when = (m: number) => (m < 3 ? "gerade eben" : m < 60 ? `vor ${m} Min.` : m < 1440 ? `vor ${Math.round(m / 60)} Std.` : `vor ${Math.round(m / 1440)} T.`);

/** Pure. A demo cast as what the mock screens show (pictures by file path; Dotty's own where the cast has none). */
export function fillFromCast(c: DemoCast): Fill {
  const person = new Map(c.people.map((p) => [p.key, p]));
  const place = new Map(c.places.map((p) => [p.key, p]));
  const av = (key: string) => person.get(key)?.avatar?.file ?? DEFAULT_FILL.me.av;
  const ph = (i: number) => c.moments[i % c.moments.length]?.photo?.file ?? DEFAULT_FILL.pins[i % 4]!.img;
  const others = c.moments.filter((m) => m.person !== c.self);
  const fire = (key: string) => c.reactions.filter((r) => r.moment === key).length;
  const rankRows = [...c.leaderboard].sort((a, b) => b.points - a.points).slice(0, 4);
  const mine = c.moments.find((m) => m.person === c.self) ?? c.moments[0]!;
  return {
    me: { name: "Du", av: av(c.self) },
    pins: others.slice(0, 4).map((m) => ({ img: m.photo?.file ?? ph(0), av: av(m.person) })),
    here: { who: person.get(others[0]!.person)!.username, place: `${place.get(others[0]!.place)?.name ?? ""} · ${place.get(others[0]!.place)?.district ?? ""}` },
    post: { img: mine.photo?.file ?? ph(0), place: place.get(mine.place)?.name ?? "", caption: mine.caption },
    feed: others.slice(0, 3).map((m) => ({ av: av(m.person), who: person.get(m.person)!.username, place: `${place.get(m.place)?.name ?? ""}${place.get(m.place)?.district ? ` · ${place.get(m.place)!.district}` : ""}`, when: when(m.minutesAgo), img: m.photo?.file ?? ph(1), live: m.minutesAgo < 30, fire: fire(m.key) })),
    rank: rankRows.map((r) => ({ av: av(r.person), who: r.person === c.self ? "Du" : person.get(r.person)!.username, pts: r.points.toLocaleString("de-DE") })),
  };
}

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

function mapScreen(a: Asset, f: Fill): string {
  const pin = (x: number, y: number, img: string, av: string, me = false, r = 0) =>
    `<div class="abs" style="left:${x}px;top:${y}px;transform:rotate(${r}deg)"><div style="width:74px;height:98px;border-radius:14px;background:${me ? "#f5c228" : "#fff"};padding:4px;box-shadow:0 3px 5px rgba(0,0,0,.32)"><img src="${a(img)}" style="width:66px;height:90px;border-radius:10px;object-fit:cover"></div><img class="av abs" src="${a(av)}" style="width:32px;height:32px;left:-10px;bottom:-10px"></div>`;
  return `${statusBar()}<img class="abs" src="${a("src/assets/welcome/map-bg.jpg")}" style="left:-40px;top:0;width:470px;height:${H}px;object-fit:cover">
<div class="abs" style="left:16px;right:16px;top:58px;display:flex;gap:10px;align-items:center"><div class="seg" style="flex:1;box-shadow:0 6px 16px rgba(0,0,0,.12)"><div class="on">Freunde</div><div>Alle</div></div><img class="av" src="${a(f.me.av)}" style="width:44px;height:44px"></div>
${[[52, 210, -6], [236, 280, 5], [120, 430, -3], [262, 500, 7]].map(([x, y, r], i) => (f.pins[i] ? pin(x!, y!, f.pins[i]!.img, f.pins[i]!.av, i === 2, r!) : "")).join("\n")}
<div class="abs" style="left:150px;top:395px;background:#fff;border-radius:16px;padding:8px 12px;box-shadow:0 6px 14px rgba(0,0,0,.16);font-size:14px;font-weight:800;white-space:nowrap">${f.here.who} ist hier 📍<div class="meta">${f.here.place}</div></div>
<div class="abs" style="left:24px;right:24px;bottom:110px;display:flex;justify-content:center"><div class="b3d" style="width:220px"><img src="${a("src/assets/3d/camera@3x.png")}" style="width:30px;height:30px">Moment teilen</div></div>
<div class="tab"><div class="on"><img src="${a("src/assets/3d/map@3x.png")}">Karte</div><div><img src="${a("src/assets/3d/feed@3x.png")}" style="opacity:.55">Feed</div><div><img src="${a("src/assets/3d/chat@3x.png")}" style="opacity:.55">Chats</div><div><img src="${a("src/assets/3d/trophy@3x.png")}" style="opacity:.55">Rangliste</div></div><div class="home"></div>`;
}

function postScreen(a: Asset, f: Fill): string {
  return `${statusBar()}<div class="abs" style="left:20px;right:20px;top:62px;display:flex;align-items:center;justify-content:space-between"><div class="h2">Dein Moment</div><div style="width:36px;height:36px;border-radius:50%;background:#f2f2f2;display:flex;align-items:center;justify-content:center;font-weight:900">✕</div></div>
<div class="abs" style="left:20px;right:20px;top:112px;height:467px;border-radius:20px;overflow:hidden;box-shadow:0 4px 10px rgba(0,0,0,.18)"><img src="${a(f.post.img)}" style="width:100%;height:100%;object-fit:cover"><div class="abs" style="left:12px;top:12px;background:rgba(255,255,255,.92);border-radius:999px;padding:6px 12px;font-weight:800;font-size:13px">gerade eben</div></div>
<div class="abs" style="left:20px;right:20px;top:596px;background:#fff;border-radius:18px;padding:12px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 6px 10px rgba(0,0,0,.08);border:1px solid #ebebeb"><div style="width:48px;height:48px;border-radius:14px;background:#f7f7f7;display:flex;align-items:center;justify-content:center"><img src="${a("src/assets/3d/restaurant@3x.png")}" style="width:36px;height:36px"></div><div style="flex:1"><div style="font-weight:800;font-size:16px">${f.post.place}</div><div class="meta">Hier bei dir · bis 100 m</div></div><div style="background:#ffe7a3;border-radius:999px;padding:6px 10px;font-weight:900;font-size:13px">12 m</div></div>
<div class="abs" style="left:20px;right:20px;top:676px;background:#f2f2f2;border-radius:16px;padding:12px 14px;font-size:15px">${f.post.caption}</div>
<div class="abs" style="left:20px;right:20px;bottom:40px"><div class="b3d">Mit Freunden teilen</div></div><div class="home"></div>`;
}

function feedScreen(a: Asset, f: Fill): string {
  const card = (top: number, av: string, who: string, place: string, when: string, img: string, live = false, fire = 0) =>
    `<div class="abs" style="left:20px;right:20px;top:${top}px;display:flex;gap:12px;padding:10px;border-radius:18px;background:#fff;box-shadow:0 6px 10px rgba(0,0,0,.08)"><div style="position:relative"><img src="${a(img)}" style="width:96px;height:128px;border-radius:12px;object-fit:cover;display:block"><img class="av abs" src="${a(av)}" style="width:34px;height:34px;left:-8px;bottom:-8px"></div><div style="flex:1;padding-top:4px"><div style="font-weight:800;font-size:16px">${who} ist hier 📍</div><div style="font-weight:700;font-size:14px;margin-top:4px">${place}</div><div class="meta" style="margin-top:6px;display:flex;align-items:center;gap:6px">${live ? '<span style="width:10px;height:10px;border-radius:50%;background:#22b455;box-shadow:0 0 0 3px rgba(34,180,85,.18)"></span>' : ""}${when}</div>${fire ? `<div style="margin-top:12px;display:inline-flex;align-items:center;gap:4px;background:#f2f2f2;border-radius:999px;padding:4px 10px 4px 6px;font-weight:800;font-size:13px"><img src="${a("src/assets/3d/fire@3x.png")}" style="width:20px;height:20px">${fire}</div>` : ""}</div></div>`;
  return `${statusBar()}<div class="abs" style="left:20px;top:62px" ><div class="hero">Feed</div></div>
<div class="abs" style="left:20px;right:20px;top:112px"><div class="seg"><div class="on">Freunde</div><div>Alle</div></div></div>
<div class="abs" style="left:20px;right:20px;top:170px;display:flex;align-items:center;gap:10px"><span class="meta" style="font-weight:800">Gerade jetzt</span><span style="flex:1;height:1px;background:#ebebeb"></span></div>
${f.feed[0] ? card(198, f.feed[0].av, f.feed[0].who, f.feed[0].place, f.feed[0].when, f.feed[0].img, f.feed[0].live, f.feed[0].fire) : ""}
${f.feed[1] ? card(356, f.feed[1].av, f.feed[1].who, f.feed[1].place, f.feed[1].when, f.feed[1].img, f.feed[1].live, f.feed[1].fire) : ""}
<div class="abs" style="left:20px;right:20px;top:516px;display:flex;align-items:center;gap:10px"><span class="meta" style="font-weight:800">Früher heute</span><span style="flex:1;height:1px;background:#ebebeb"></span></div>
${f.feed[2] ? card(544, f.feed[2].av, f.feed[2].who, f.feed[2].place, f.feed[2].when, f.feed[2].img, f.feed[2].live, f.feed[2].fire) : ""}
<div class="tab"><div><img src="${a("src/assets/3d/map@3x.png")}" style="opacity:.55">Karte</div><div class="on"><img src="${a("src/assets/3d/feed@3x.png")}">Feed</div><div><img src="${a("src/assets/3d/chat@3x.png")}" style="opacity:.55">Chats</div><div><img src="${a("src/assets/3d/trophy@3x.png")}" style="opacity:.55">Rangliste</div></div><div class="home"></div>`;
}

function recapScreen(a: Asset, f: Fill): string {
  const row = (n: number, av: string, who: string, pts: string, medal: string | null, me = false) =>
    `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:16px;background:${me ? "#ffe7a3" : "#fff"};${me ? "" : "border:1px solid #ebebeb"}">${medal ? `<img src="${a(medal)}" style="width:34px;height:34px">` : `<span style="width:34px;text-align:center;font-weight:900;color:#b0b0b0">${n}</span>`}<img class="av" src="${a(av)}" style="width:40px;height:40px"><span style="flex:1;font-weight:800;font-size:16px">${who}</span><span style="font-weight:900">${pts}</span></div>`;
  return `${statusBar(true)}<img class="abs" src="${a("src/assets/welcome/burst.jpg")}" style="left:0;top:0;width:${W}px;height:420px;object-fit:cover">
<div class="abs" style="left:0;right:0;top:70px;text-align:center"><div style="font-weight:800;font-size:14px;letter-spacing:.06em">DEIN WOCHENRÜCKBLICK</div></div>
<div class="abs" style="left:0;right:0;top:110px;display:flex;justify-content:center"><img src="${a("src/assets/3d/trophy@3x.png")}" style="width:120px;height:120px;filter:drop-shadow(0 10px 14px rgba(0,0,0,.2))"></div>
<div class="abs" style="left:24px;right:24px;top:246px;text-align:center"><div class="hero">${f.rank[0]?.who === "Du" ? "Du hast die Woche gewonnen 🎉" : `${f.rank[0]?.who ?? ""} hat die Woche gewonnen 🎉`}</div><div class="meta" style="margin-top:8px;color:#222;opacity:.75">14 Momente · 9 Orte</div></div>
<div class="abs" style="left:20px;right:20px;top:440px;display:flex;flex-direction:column;gap:10px">${f.rank.map((x, i) => row(i + 1, x.av, x.who, x.pts, i < 3 ? `src/assets/3d/medal${i + 1}@3x.png` : null, x.who === "Du")).join("")}</div>
<div class="abs" style="left:20px;right:20px;bottom:40px"><div class="b3d">Rückblick teilen</div></div><div class="home"></div>`;
}

export const DOTTY_MOCKS = [
  { name: "karte", build: mapScreen, shows: "Die Karte: wo deine Freunde gerade sind" },
  { name: "moment", build: postScreen, shows: "Einen Moment teilen — nur wo du wirklich bist" },
  { name: "feed", build: feedScreen, shows: "Feed: wer gerade wo ist" },
  { name: "rueckblick", build: recapScreen, shows: "Wochenrückblick mit Rangliste" },
] as const;

/** Renders the mock screens (1170×2532 PNG) into `dir` — with a demo cast's people and moments when given. */
export async function renderDottyMocks(dottyRepo: string, dir: string, browser?: Browser, cast?: DemoCast | null): Promise<ScreenAsset[]> {
  mkdirSync(dir, { recursive: true });
  const a: Asset = (p) => fileUri(p.startsWith("/") ? p : join(dottyRepo, p)) ?? "";
  const fill = cast ? fillFromCast(cast) : DEFAULT_FILL;
  return withBrowser(async (b) => {
    const out: ScreenAsset[] = [];
    for (const m of DOTTY_MOCKS) {
      const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 3 });
      await page.setContent(`<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css(a)}</style></head><body>${m.build(a, fill)}</body></html>`, { waitUntil: "load" });
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
