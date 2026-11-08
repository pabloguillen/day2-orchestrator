/**
 * Renders every template for Dotty with its brand kit and MOCK German screens (docs/creative-quality.md):
 *   bun run src/creative/samples-cli.ts <dotty repo> <out dir>
 * MP4s, carousel slides, contact sheets, the extracted brand kit and a layout-check report.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDottyMocks } from "./fixtures/dotty-mock-screens";
import { extractBrandKit, resolveKit } from "./brand-kit";
import { renderTemplate, contactSheet } from "./render";
import { layoutIssues } from "./critique";
const DOTTY = process.argv[2] ?? "../dotty";
const OUT = process.argv[3] ?? "creative-samples";
mkdirSync(OUT, { recursive: true });
const screens = await renderDottyMocks(DOTTY, join(OUT, "mock-screens-de"));
const extracted = extractBrandKit(DOTTY);
writeFileSync(join(OUT, "dotty-brand-kit.json"), JSON.stringify(extracted, null, 2));
const kit = resolveKit({ extracted, overrides: {}, updatedAt: "" }, { repoPath: DOTTY, appName: "Dotty" });
const base = { problem: [], pov: null, cta: "Link in Bio", endLine: "Dein Leben mit Freunden auf der Karte", version: null, broll: null, kicker: null };
const jobs: any[] = [
 ["how-it-works", { ...base, template: "how-it-works", hook: "Sieh, wo deine Freunde gerade sind", kicker: "So geht Dotty", steps: [
   { headline: "Freunde auf der Karte", caption: "Du siehst sofort, wer gerade wo unterwegs ist", screen: 0, focus: { x: 0.28, y: 0.44, w: 0.5, h: 0.2 }, tap: null, sticker: "map" },
   { headline: "Teil deinen Moment", caption: "Foto machen, Dotty erkennt den Ort, an dem du bist", screen: 1, focus: { x: 0.04, y: 0.69, w: 0.92, h: 0.1 }, tap: { x: 0.5, y: 0.93 }, sticker: "camera" },
   { headline: "Sieh, wer gerade wo ist", caption: "Im Feed: live, was deine Freunde gerade machen", screen: 2, focus: { x: 0.04, y: 0.23, w: 0.92, h: 0.19 }, tap: null, sticker: "fire" },
   { headline: "Gewinn die Woche", caption: "Jeden Montag dein Rückblick mit Rangliste", screen: 3, focus: { x: 0.05, y: 0.52, w: 0.9, h: 0.2 }, tap: null, sticker: "trophy" } ] }],
 ["feature-spotlight", { ...base, template: "feature-spotlight", kicker: "Nur bei Dotty", hook: "Teilen geht nur vor Ort", steps: [
   { headline: "Foto machen", caption: "Du machst ein Foto, Dotty erkennt den Ort", screen: 1, focus: { x: 0.04, y: 0.13, w: 0.92, h: 0.56 }, tap: null, sticker: "camera" },
   { headline: "Bis 100 Meter", caption: "Nur wo du wirklich bist, kein Fake-Check-in", screen: 1, focus: { x: 0.04, y: 0.7, w: 0.92, h: 0.085 }, tap: { x: 0.5, y: 0.93 }, sticker: "pin" } ] }],
 ["pov-hook", { ...base, template: "pov-hook", hook: "POV", pov: "POV: Du willst wissen, wo alle sind", broll: 0, steps: [
   { headline: "Ein Blick auf die Karte", caption: "Und du siehst sofort, wer gerade wo ist", screen: 0, focus: { x: 0.1, y: 0.22, w: 0.8, h: 0.45 }, tap: null, sticker: "map" } ] }],
 ["problem-solution", { ...base, template: "problem-solution", hook: "Wo seid ihr eigentlich?", problem: ["wo seid ihr?", "im park glaub ich", "welcher park??", "hallo???"], steps: [
   { headline: "Einfach auf die Karte schauen", caption: "Dotty zeigt dir, wo deine Freunde gerade sind", screen: 0, focus: { x: 0.1, y: 0.22, w: 0.8, h: 0.25 }, tap: null, sticker: "map" } ] }],
 ["launch", { ...base, template: "launch", kicker: "Neu im App Store", hook: "Dotty ist da", steps: [
   { headline: "Karte", caption: "Sieh, wo deine Freunde gerade sind", screen: 0, focus: null, tap: null, sticker: null },
   { headline: "Moment", caption: null, screen: 1, focus: null, tap: null, sticker: null },
   { headline: "Feed", caption: null, screen: 2, focus: null, tap: null, sticker: null } ] }],
 ["whats-new", { ...base, template: "whats-new", version: "1.0.2", hook: "Neu in Dotty", steps: [
   { headline: "Wochenrückblick", caption: "Jeden Montag: deine Woche mit Rangliste", screen: 3, focus: { x: 0.05, y: 0.52, w: 0.9, h: 0.2 }, tap: null, sticker: "trophy" },
   { headline: "Feed mit Freunden und Alle", caption: "Wechsel zwischen Freunden und allen in der Nähe", screen: 2, focus: { x: 0.04, y: 0.13, w: 0.92, h: 0.07 }, tap: { x: 0.72, y: 0.165 }, sticker: "feed" } ] }],
];
const report: string[] = [];
for (const [id, shots] of jobs) {
  const d = join(OUT, id);
  const r = await renderTemplate(id, { shots, kit, screens, broll: [{ file: join(DOTTY, "src/assets/welcome/pizza.jpg"), kind: "image" }] }, { dir: d, name: id, ratios: ["4:5", "1:1"] });
  if (r.video) {
    await contactSheet(r.video.frames.map((f) => f.file), join(d, `${id}-video-contact-sheet.jpg`), { cols: r.video.frames.length, width: 360 });
    for (const f of r.video.frames) rmSync(f.file, { force: true });
  }
  for (const s of r.slides) if (s.files.length > 1) await contactSheet(s.files, join(d, `${id}-${s.ratio.replace(":", "x")}-carousel-sheet.jpg`), { cols: Math.min(6, s.files.length), width: 360 });
  const issues = layoutIssues({ rendered: r, screens, language: "de", hasIcon: true });
  report.push(`${id}: video ${r.video ? r.video.seconds + "s" : "—"}, slides ${r.slides.map((s) => `${s.ratio}×${s.files.length}`).join(", ") || "—"}; layout check: ${issues.length ? issues.map((i) => i.text).join("; ") : "clean"}`);
}
writeFileSync(join(OUT, "README.txt"), `day2 creative-quality samples for Dotty (rendered ${new Date().toISOString()})

Brand kit: read automatically from the Dotty repo (dotty-brand-kit.json): yellow ${kit.primary} from the icon, ink ${kit.ink}, Nunito Black/SemiBold (embedded from the repo's font files), corner radius ${kit.radius}, the app's own 3D stickers and icon.

SCREENS ARE MOCK CAPTURES (mock-screens-de/): there's no iPhone Simulator on this machine, so Dotty's key screens were rebuilt in HTML from its own tokens, fonts, 3D icons and bundled demo pictures, in German, at simulator size (1170x2532, status bar included). A real run uses simulator captures (src/creative/capture.ts).
POV b-roll: Dotty's bundled 330x440 demo photo (pizza.jpg) stands in for a real clip (creator tools / owner uploads), so it's soft.

Per template: <id>.mp4 (9:16, H.264 High, AAC 48 kHz, sound cues + built-in beat), <id>-video-contact-sheet.jpg (first second, each step, end card), carousel slides 4:5 and 1:1 (+ contact sheets).

${report.join("\n")}
`);
console.log(report.join("\n"));
