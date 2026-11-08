/**
 * A demo cast for Dotty with the deterministic fake model, its seed plan
 * against Dotty's migrations, and a How it works post rendered from MOCK
 * screens filled with that cast (docs/creative-quality.md, "Real screens"):
 *   bun run src/creative/demo-cast/sample-cli.ts <dotty repo> <out dir>
 * No model, no image tool, no Supabase, no simulator: pictures are Dotty's
 * own bundled demo pictures (what day2 uses when no image tool is connected).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileAssetStore } from "../../ads/assets";
import { introspectMigrations } from "../../hosting/schema-introspect";
import { readMigrations } from "../../hosting/migrations";
import { expandSeedPlan, heuristicSeedPlan } from "../../hosting/seed-plan";
import { extractBrandKit, resolveKit } from "../brand-kit";
import { layoutIssues } from "../critique";
import { demoFlowTicket } from "../demo-flow";
import { renderDottyMocks } from "../fixtures/dotty-mock-screens";
import { contactSheet, renderTemplate } from "../render";
import { fakeCastModel, generateCast } from "./generate";
import { addCastImages } from "./images";

const DOTTY = process.argv[2] ?? "../dotty";
const OUT = process.argv[3] ?? "real-screens-sample";
const SEED = 2026;
mkdirSync(OUT, { recursive: true });

const { cast, note } = await generateCast(
  { appId: "dotty", appName: "Dotty", purpose: "Sieh, wo deine Freunde gerade sind: Momente teilen, nur wo du wirklich bist.", features: ["Karte mit Freunden (Freunde/Alle)", "Moment teilen vor Ort", "Feed", "Wochenrangliste"], audience: "junge Leute in Deutschland (18–25)", language: "de", tone: "casual (du), uses emoji" },
  { model: fakeCastModel(SEED), seed: SEED, now: new Date("2026-11-08T12:00:00Z") },
);
const store = fileAssetStore(join(OUT, ".assets"), "https://day2.local");
const kit = resolveKit({ extracted: extractBrandKit(DOTTY), overrides: {}, updatedAt: "" }, { repoPath: DOTTY, appName: "Dotty" });
const withImages = await addCastImages(cast, { kit: null, store, repoPath: DOTTY, appName: "Dotty", colors: [kit.primary] });
const forJson = { ...withImages, status: "approved", people: withImages.people.map((p) => ({ ...p, avatar: p.avatar ? { ...p.avatar, file: null } : null })), moments: withImages.moments.map((m) => ({ ...m, photo: m.photo ? { ...m.photo, file: null } : null })) };
writeFileSync(join(OUT, "demo-cast.json"), JSON.stringify(forJson, null, 2));

const schema = introspectMigrations(readMigrations(DOTTY));
const { plan, problems } = heuristicSeedPlan(schema);
if (!plan) throw new Error(problems.join("; "));
writeFileSync(join(OUT, "seed-plan.json"), JSON.stringify(plan, null, 2));
const ids = Object.fromEntries(cast.people.map((p, i) => [p.key, `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`]));
const rows = expandSeedPlan(plan, withImages, ids, schema, new Date("2026-11-08T12:00:00Z"));
writeFileSync(join(OUT, "seed-rows-preview.json"), JSON.stringify({ note: "What day2 would insert into a capture's temporary database (user ids are placeholders; real ones come from its Auth).", inserts: rows.inserts.map((i) => ({ table: i.table, rows: i.rows.length, first: i.rows[0] })), uploads: rows.uploads.map((u) => ({ bucket: u.bucket, path: u.path })), skipped: rows.skipped }, null, 2));
writeFileSync(join(OUT, "demo-flow-ticket.txt"), (({ title, description, doneWhen }) => `${title}\n\n${description}\n\nDone when:\n- ${(doneWhen ?? []).join("\n- ")}\n`)(demoFlowTicket({ appName: "Dotty", features: ["Karte mit Freunden", "Moment teilen", "Feed", "Wochenrangliste"], locale: "de-DE", cast: withImages, hasStoreFlow: false, existingNotes: [], record: true })));

const screens = await renderDottyMocks(DOTTY, join(OUT, "mock-screens-cast-de"), undefined, withImages);
const person = (k: string) => withImages.people.find((p) => p.key === k)!;
const shots = {
  template: "how-it-works" as const,
  hook: "Sieh, wo deine Freunde gerade sind",
  kicker: "So geht Dotty",
  problem: [],
  pov: null,
  cta: "Link in Bio",
  endLine: "Dein Leben mit Freunden auf der Karte",
  version: null,
  broll: null,
  steps: [
    { headline: "Freunde auf der Karte", caption: `${person(withImages.moments[0]!.person).displayName} und die anderen — live, wo sie gerade sind`, screen: 0, focus: { x: 0.1, y: 0.22, w: 0.8, h: 0.45 }, tap: null, sticker: "map" },
    { headline: "Teil deinen Moment", caption: "Foto machen, Dotty erkennt den Ort, an dem du bist", screen: 1, focus: { x: 0.04, y: 0.69, w: 0.92, h: 0.1 }, tap: { x: 0.5, y: 0.93 }, sticker: "camera" },
    { headline: "Sieh, wer gerade wo ist", caption: "Im Feed: was deine Freunde gerade machen", screen: 2, focus: { x: 0.04, y: 0.23, w: 0.92, h: 0.19 }, tap: null, sticker: "fire" },
    { headline: "Gewinn die Woche", caption: "Jeden Montag dein Rückblick mit Rangliste", screen: 3, focus: { x: 0.05, y: 0.52, w: 0.9, h: 0.2 }, tap: null, sticker: "trophy" },
  ],
};
const dir = join(OUT, "how-it-works");
const r = await renderTemplate("how-it-works", { shots, kit: { ...kit, language: "de" }, screens, broll: [] }, { dir, name: "how-it-works", ratios: ["4:5", "1:1"] });
if (r.video) {
  await contactSheet(r.video.frames.map((f) => f.file), join(dir, "how-it-works-video-contact-sheet.jpg"), { cols: r.video.frames.length, width: 360 });
  for (const f of r.video.frames) rmSync(f.file, { force: true });
}
for (const s of r.slides) if (s.files.length > 1) await contactSheet(s.files, join(dir, `how-it-works-${s.ratio.replace(":", "x")}-carousel-sheet.jpg`), { cols: Math.min(6, s.files.length), width: 360 });
const issues = layoutIssues({ rendered: r, screens, language: "de", hasIcon: true });
rmSync(join(OUT, ".assets"), { recursive: true, force: true });

const summary = `day2 real-screens sample for Dotty (${new Date().toISOString()})

Demo cast (demo-cast.json): ${note}. ${withImages.people.length} invented adults (${withImages.people.map((p) => `${p.displayName} ${p.age}`).join(", ")}), ${withImages.places.length} places, ${withImages.moments.length} moments, ${withImages.reactions.length} reactions, ${withImages.comments.length} comments. Self (the demo account): ${person(withImages.self).displayName}.
Pictures: ${withImages.images.note}
  (With OpenAI Images connected for posts, day2 generates profile photos of invented adults and moment photos instead, marked AI-generated / AI person.)

Seed plan (seed-plan.json): built-in planner from Dotty's ${readMigrations(DOTTY).length} migrations → ${plan.steps.map((s) => s.table).join(", ")}; uploads to ${plan.uploads.map((u) => u.bucket).join(", ")}. ${plan.notes.join(" ")}
Rows preview (seed-rows-preview.json): ${rows.inserts.map((i) => `${i.table} ${i.rows.length}`).join(", ")}; ${rows.uploads.length} pictures.

Flow ticket (demo-flow-ticket.txt): what day2's build agent gets for the Maestro flow + demo sign-in + demo build profile.

SCREENS ARE MOCK CAPTURES filled with the cast (mock-screens-cast-de/) — no simulator here. A real run starts a temporary database (Docker), seeds it, builds Dotty against it and captures with Maestro (capture-run.ts).
How it works (how-it-works/): video ${r.video ? `${r.video.seconds}s` : "—"}, slides ${r.slides.map((s) => `${s.ratio}×${s.files.length}`).join(", ")}; layout check: ${issues.length ? issues.map((i) => i.text).join("; ") : "clean"}.
`;
writeFileSync(join(OUT, "README.txt"), summary);
console.log(summary);
