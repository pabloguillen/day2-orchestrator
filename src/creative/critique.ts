import { randomBytes } from "node:crypto";
import type { TextBox } from "./motion/engine";
import type { Rendered } from "./render";
import { SAFE_916 } from "./templates/parts";
import type { ScreenAsset, ShotList } from "./templates/types";
import { CRITERIA, CURRENT_RUBRIC, passes, rubricText, weightedScore, type CriterionId, type Scores } from "./taste";
import { jsonAfter, type VisionImage, type VisionRun } from "./vision";

/**
 * The design critique (docs/creative-quality.md): after every render, day2
 * checks the layout it knows exactly (safe zones, text size, clutter, cut-off
 * text, language of the screens, the real icon) and a vision critic scores
 * sampled frames and slides against the rubric. Approve, or send concrete
 * fixes back to the art director for a re-render — at most 2 rounds. What
 * still fails is dropped with the reason in the log, never shown.
 */

export const CRITIQUE_MAX_USD = 0.35;
export const MAX_ROUNDS = 2;
const MARKER = "CRITIQUE_JSON:";

export type Issue = { criterion: CriterionId; severity: "blocker" | "major" | "minor"; text: string; fix: string };
export type Critique = {
  rubricVersion: number;
  scores: Scores;
  score: number;
  verdict: "approve" | "fix" | "drop";
  issues: Issue[];
  fixes: string[];
  /** One owner-facing line: why this works. */
  why: string | null;
  bySight: boolean;
};

const READ_ROLES = new Set(["hook", "headline", "caption", "kicker", "badge", "cta", "name", "endline", "pov", "bubble", "sub", "swipe"]);

/** What day2 can check exactly from where it put the text. Pure. */
export function layoutIssues(o: { rendered: Rendered; screens: ScreenAsset[]; language: string; hasIcon: boolean; warned?: boolean }): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  const add = (i: Issue) => {
    const k = `${i.criterion}|${i.text}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(i);
    }
  };
  const checkBoxes = (boxes: TextBox[], W: number, H: number, where: string, vertical916: boolean) => {
    const vis = boxes.filter((b) => b.visible && READ_ROLES.has(b.role) && b.text);
    for (const b of vis) {
      if (b.x < -2 || b.x + b.w > W + 2 || b.y < -2 || b.y + b.h > H + 2) add({ criterion: "legibility", severity: "blocker", text: `“${b.text.slice(0, 40)}” is cut off ${where}`, fix: `shorten the ${b.role} “${b.text.slice(0, 40)}”` });
      if (b.px < 30) add({ criterion: "legibility", severity: "major", text: `the ${b.role} is too small to read on a phone ${where} (${Math.round(b.px)} px)`, fix: `shorten the ${b.role} so it can be set larger` });
      if (vertical916 && (b.y < SAFE_916.top - 12 || b.y + b.h > SAFE_916.bottom + 12 || b.x + b.w > W - 120)) add({ criterion: "safe_zones", severity: "blocker", text: `the ${b.role} sits under the TikTok/Reels buttons or captions ${where}`, fix: `shorten the ${b.role} “${b.text.slice(0, 40)}”` });
    }
    const main = vis.filter((b) => b.role !== "bubble" && b.role !== "badge");
    if (main.length > 4) add({ criterion: "clutter", severity: "major", text: `${main.length} pieces of text at once ${where}`, fix: "drop the sub lines or captions on busy steps" });
  };
  const v = o.rendered.video;
  if (v) for (const f of v.frames) checkBoxes(f.boxes, 1080, 1920, `at ${f.t.toFixed(1)} s`, true);
  for (const s of o.rendered.slides) s.boxes.forEach((b, k) => checkBoxes(b, 1080, s.ratio === "4:5" ? 1350 : s.ratio === "1:1" ? 1080 : 1920, `on slide ${k + 1} (${s.ratio})`, false));
  const foreign = o.screens.filter((s) => s.language && s.language !== o.language);
  if (foreign.length) add({ criterion: "language", severity: o.warned ? "major" : "blocker", text: `${foreign.length} of the app's screens are in ${foreign[0]!.language === "en" ? "English" : foreign[0]!.language} under ${o.language} text`, fix: "use screens captured in the audience's language" });
  if (!o.screens.length) add({ criterion: "real_product", severity: "blocker", text: "no real screen of the app", fix: "capture the app's screens first" });
  if (!o.hasIcon) add({ criterion: "real_product", severity: "minor", text: "no app icon found: the end card shows the name only", fix: "add the app icon (app.json → icon)" });
  return out;
}

/** Layout findings cap the matching scores (a blocker can't pass). Pure. */
export function applyIssues(scores: Scores, issues: Issue[]): Scores {
  const out: Scores = { ...scores };
  for (const i of issues) {
    const cap = i.severity === "blocker" ? 3 : i.severity === "major" ? 6 : 8;
    out[i.criterion] = Math.min(out[i.criterion] ?? 10, cap);
  }
  return out;
}

export function buildCritiquePrompt(o: { appName: string; language: string; template: string; kitBrief: string; isVideo: boolean; layout: Issue[] }, nonce = randomBytes(6).toString("hex")): string {
  return `You are a strict creative director reviewing a social post for the app ${o.appName} before it goes to the owner. The images above are frames sampled from the ${o.isVideo ? "9:16 video (first second, each step, the end card)" : "carousel/stills"} — template: ${o.template}. Audience language: ${o.language}.

<<<DATA ${nonce} brand kit>>>
${o.kitBrief.replace(/<<<|>>>/g, "")}
<<<END ${nonce}>>>

The rubric (score each criterion 0–10, honestly — 7 is "a good app-marketing designer would ship this"):
${rubricText()}

Already measured by day2 (trust these): ${o.layout.length ? o.layout.map((i) => i.text).join("; ") : "nothing wrong with safe zones, sizes or language of the screens"}.
${o.isVideo ? "" : 'Skip "pacing" (stills).'}

Give concrete fixes the art director can apply by changing the shot list (words, which screen, focus box, template) — not vague advice. "why" is one short owner-facing sentence on why this works (in English), or null if it doesn't.

End with this marker on its own line, then JSON only:
${MARKER}
{"scores":{${CRITERIA.map((c) => `"${c.id}":0`).join(",")}},"verdict":"approve|fix|drop","fixes":[""],"why":""}`;
}

/** The critic's answer → scores, verdict, fixes (null when unreadable). Pure. */
export function parseCritique(text: string): { scores: Scores; verdict: "approve" | "fix" | "drop"; fixes: string[]; why: string | null } | null {
  const raw = jsonAfter(text, MARKER);
  if (!raw || typeof raw.scores !== "object" || !raw.scores) return null;
  const scores: Scores = {};
  for (const c of CRITERIA) {
    const v = (raw.scores as Record<string, unknown>)[c.id];
    if (typeof v === "number" && Number.isFinite(v)) scores[c.id] = Math.max(0, Math.min(10, v));
  }
  if (!Object.keys(scores).length) return null;
  const verdict = raw.verdict === "approve" || raw.verdict === "drop" ? raw.verdict : "fix";
  const fixes = Array.isArray(raw.fixes) ? raw.fixes.filter((f): f is string => typeof f === "string" && f.trim().length > 3).map((f) => f.replace(/[<>]/g, "").trim().slice(0, 200)).slice(0, 6) : [];
  const why = typeof raw.why === "string" && raw.why.trim() ? raw.why.replace(/[<>]/g, "").trim().slice(0, 160) : null;
  return { scores, verdict, fixes, why };
}

/** The frames the critic looks at: video samples, then up to 6 slides of the first ratio. Pure. */
export function critiqueImages(r: Rendered): VisionImage[] {
  const out: VisionImage[] = [];
  if (r.video) for (const f of r.video.frames) out.push({ label: `Video frame at ${f.t.toFixed(1)} s:`, file: f.file });
  const s = r.slides[0];
  if (s) s.files.slice(0, 6).forEach((f, k) => out.push({ label: `Slide ${k + 1} (${s.ratio}):`, file: f }));
  return out;
}

/** Judges one render: layout facts + (when available) the vision critic. */
export async function critique(o: { rendered: Rendered; screens: ScreenAsset[]; language: string; hasIcon: boolean; appName: string; kitBrief: string; vision: VisionRun | null; warned?: boolean }): Promise<Critique> {
  const layout = layoutIssues(o);
  let scores: Scores = {};
  let fixes: string[] = [];
  let why: string | null = null;
  let verdict: Critique["verdict"] = "approve";
  let bySight = false;
  if (o.vision) {
    try {
      const text = await o.vision({ prompt: buildCritiquePrompt({ appName: o.appName, language: o.language, template: o.rendered.template, kitBrief: o.kitBrief, isVideo: Boolean(o.rendered.video), layout }), images: critiqueImages(o.rendered), maxUsd: CRITIQUE_MAX_USD, label: "Design critique" });
      const p = parseCritique(text);
      if (p) {
        scores = p.scores;
        fixes = p.fixes;
        why = p.why;
        verdict = p.verdict;
        bySight = true;
      }
    } catch {
      /* the layout checks still decide */
    }
  }
  if (!bySight) {
    // Without eyes: the template's baseline (designed to pass) minus what the layout checks found.
    scores = Object.fromEntries(CRITERIA.map((c) => [c.id, 7.5])) as Scores;
    if (!o.rendered.video) delete scores.pacing;
  }
  if (!o.rendered.video) delete scores.pacing;
  scores = applyIssues(scores, layout);
  const p = passes(scores);
  const allFixes = [...new Set([...layout.filter((i) => i.severity !== "minor").map((i) => i.fix), ...fixes])].slice(0, 8);
  const final: Critique["verdict"] = p.ok && verdict !== "drop" ? "approve" : verdict === "drop" && bySight ? "drop" : "fix";
  return { rubricVersion: CURRENT_RUBRIC, scores, score: weightedScore(scores), verdict: final, issues: layout, fixes: allFixes, why: final === "approve" ? why : null, bySight };
}

export type LoopResult<R> = { ok: true; shots: ShotList; rendered: R; critique: Critique; rounds: number; history: Critique[] } | { ok: false; reason: string; history: Critique[]; rounds: number };

/**
 * Render → critique → (fix → re-render) at most MAX_ROUNDS times. `direct`
 * gets the critic's fixes and the last shot list; `render` makes the media.
 * Injected so it runs the same with fakes in tests.
 */
export async function critiqueLoop<R extends Rendered>(o: { first: ShotList; render: (s: ShotList, round: number) => Promise<R>; judge: (r: R) => Promise<Critique>; direct: (fixes: string[], prev: ShotList) => Promise<ShotList>; log?: (t: string) => void }): Promise<LoopResult<R>> {
  let shots = o.first;
  const history: Critique[] = [];
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const rendered = await o.render(shots, round);
    const c = await o.judge(rendered);
    history.push(c);
    o.log?.(`Critique round ${round + 1}: ${c.score}/10 — ${c.verdict}${c.fixes.length ? ` (${c.fixes.slice(0, 2).join("; ")})` : ""}`);
    if (c.verdict === "approve") return { ok: true, shots, rendered, critique: c, rounds: round + 1, history };
    if (c.verdict === "drop" || round === MAX_ROUNDS) {
      const worst = CRITERIA.filter((x) => typeof c.scores[x.id] === "number").sort((a, b) => c.scores[a.id]! - c.scores[b.id]!)[0];
      return { ok: false, reason: `the design critique didn't pass after ${round + 1} ${round ? "rounds" : "round"} (${c.score}/10${worst ? `, weakest: ${worst.label.toLowerCase()}` : ""}${c.issues[0] ? `; ${c.issues[0].text}` : ""})`, history, rounds: round + 1 };
    }
    shots = await o.direct(c.fixes, shots);
  }
  return { ok: false, reason: "the design critique didn't pass", history, rounds: MAX_ROUNDS + 1 };
}
