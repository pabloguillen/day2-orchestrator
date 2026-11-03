import { renderBrandBrief } from "../brand-dna";
import { indexRepo } from "../distribution-loops";
import { meteredQuery } from "../metered-query";
import type { EventLike } from "../metrics/types";
import type { AppProfile } from "../onboarding";
import type { RetentionSnapshot } from "../retention";
import type { Json } from "../../packages/sensors/src/types";
import { KEY_RE } from "./experiments";
import type { Idea, LiveState, Metric, Variant } from "./types";

/**
 * Experiment ideas: an agent reads what day2 knows about the app (its code,
 * profile, brand DNA, numbers and the biggest retention leak) and proposes
 * a few experiments that change settings, not code where possible. The
 * owner can also describe one in plain words; the same agent writes it up.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
export const IDEAS_EVERY_DAYS = 14;
export const IDEAS_MAX_USD = 1;

export type IdeaDraft = Omit<Idea, "id" | "createdAt" | "status" | "experimentId">;

export type IdeaInput = {
  appName: string;
  profile: Pick<AppProfile, "purpose" | "targetUsers" | "featureMap" | "businessModel" | "toneOfVoice" | "brand"> | null;
  /** What the code is: screens and files, plus the settings it already reads from Live. */
  code: { files: string[]; liveKeys: string[]; excerpts: Array<{ file: string; text: string }> };
  values: Record<string, Json>;
  numbers: { users: number; events: Array<{ type: string; count: number }>; revenuePerUser: number | null; currency: string | null };
  leak: { state: string; lost: number; rate: number | null } | null;
  tried: string[];
  /** The owner's own words, for "describe an experiment" (one idea back). */
  ownerWords?: string;
};

const CODE_FILE = /\.(t|j)sx?$/;
const SCREENS = /(app|screens?|pages?|routes?|components)\//i;

/** What the prompt says about the code: files that look like screens, and short excerpts of where settings could come from. */
export function codeSummary(repoPath: string, liveKeys: Set<string>): IdeaInput["code"] {
  const repo = indexRepo(repoPath);
  const files = repo.files.filter((f) => CODE_FILE.test(f) && !/(test|spec|\.d\.ts|day2\/)/.test(f));
  const screens = files.filter((f) => SCREENS.test(f)).slice(0, 60);
  const interesting = files.filter((f) => /(onboard|paywall|welcome|home|index|sign|subscribe|settings)/i.test(f)).slice(0, 4);
  return {
    files: screens,
    liveKeys: [...liveKeys].sort(),
    excerpts: interesting.map((file) => {
      const text = repo.read(file);
      return { file, text: text.length > 2500 ? `${text.slice(0, 2500)}\n… (trimmed)` : text };
    }),
  };
}

/** The app's numbers for the prompt: users, most common events, revenue per user. */
export function numbersFrom(events: EventLike[]): IdeaInput["numbers"] {
  const units = new Set(events.map((e) => e.userId ?? e.deviceId));
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const money = events.filter((e) => e.value && (e.type === "revenue" || e.type === "refund"));
  const currency = money[0]?.value?.currency ?? null;
  const total = money.filter((e) => e.value!.currency === currency).reduce((s, e) => s + (e.type === "refund" ? -1 : 1) * e.value!.amount, 0);
  return {
    users: units.size,
    events: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([type, count]) => ({ type, count })),
    revenuePerUser: units.size && currency ? Math.round((total / units.size) * 100) / 100 : null,
    currency,
  };
}

export function leakFrom(s: RetentionSnapshot | null): IdeaInput["leak"] {
  if (!s || s.status !== "ready" || !s.leak) return null;
  return { state: s.leak, lost: s.lost[s.leak], rate: s.rates[s.leak] };
}

export function ideaPrompt(input: IdeaInput): string {
  const p = input.profile;
  const one = Boolean(input.ownerWords);
  return [
    one
      ? `The owner of the mobile app "${input.appName}" wants to run this experiment, in their words:\n"""${input.ownerWords!.slice(0, 1500)}"""\nWrite it up as one experiment day2 can run.`
      : `You propose experiments for the mobile app "${input.appName}" (React Native / Expo). day2 runs them over the air: the app reads settings from day2 ("Live config"), so an experiment changes setting values, not code.`,
    "",
    "## The app",
    p ? `Purpose: ${p.purpose}\nUsers: ${p.targetUsers}\nFeatures: ${p.featureMap.join(", ")}\nBusiness model: ${p.businessModel ?? "unknown"}\nTone: ${p.toneOfVoice ?? "unknown"}` : "(no profile yet)",
    renderBrandBrief(p?.brand ?? null),
    "",
    "## The code",
    `Screens and components: ${input.code.files.join(", ") || "(unknown)"}`,
    `Settings the code already reads from Live (experiments on these need no code change): ${input.code.liveKeys.join(", ") || "(none yet)"}`,
    `Current setting values: ${JSON.stringify(input.values).slice(0, 2000)}`,
    ...input.code.excerpts.map((x) => `### ${x.file}\n\`\`\`\n${x.text}\n\`\`\``),
    "",
    "## The numbers (last 30 days)",
    `Users: ${input.numbers.users}. Events: ${input.numbers.events.map((e) => `${e.type} ${e.count}`).join(", ") || "none yet"}.`,
    input.numbers.revenuePerUser !== null ? `Revenue per user: ${input.numbers.revenuePerUser} ${input.numbers.currency}.` : "No revenue events yet.",
    input.leak ? `Biggest retention leak: users in state "${input.leak.state}" (${input.leak.lost} lost last period${input.leak.rate !== null ? `, ${Math.round(input.leak.rate * 100)}% come back` : ""}).` : "Retention: not enough data yet.",
    input.tried.length ? `Already tried (don't repeat): ${input.tried.join("; ")}` : "",
    "",
    "## Rules",
    "- Each experiment changes 1–3 settings. Prefer settings the code already reads. A new setting name is fine when the change is small for the build agent (a text, a number, a switch, an order), named like `onboarding.title` or `paywall.trial_days`.",
    '- Versions: "control" (today\'s value — leave its values empty) and 1–2 others, with concrete values in the app\'s own voice and language.',
    '- One goal: an event the app sends (`{"kind":"event","event":"<type>"}` — only events listed above), `{"kind":"retention_d7"}`, or `{"kind":"revenue_per_user"}` when the app earns money.',
    "- Aim at the biggest leak or the weakest step first. No dark patterns, no fake urgency, nothing that misleads users.",
    "",
    `Answer with JSON only: {"ideas": [${one ? "exactly one" : "2–4"} of {"title": "short", "hypothesis": "If we …, then … because …", "why": "the number or fact behind it", "keys": ["…"], "variants": [{"name": "control", "weight": 50, "values": {}}, {"name": "<short-name>", "weight": 50, "values": {"<key>": <value>}}], "metric": {…}}]}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function metricOf(v: unknown): Metric | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (m.kind === "event" && typeof m.event === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(m.event)) return { kind: "event", event: m.event };
  if (m.kind === "retention_d7") return { kind: "retention_d7" };
  if (m.kind === "revenue_per_user") return { kind: "revenue_per_user" };
  return null;
}

/** The agent's answer → checked ideas (anything malformed is dropped). */
export function parseIdeas(text: string): IdeaDraft[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const list = (raw as { ideas?: unknown }).ideas;
  if (!Array.isArray(list)) return [];
  const out: IdeaDraft[] = [];
  for (const x of list.slice(0, 6)) {
    if (!x || typeof x !== "object") continue;
    const i = x as Record<string, unknown>;
    const keys = Array.isArray(i.keys) ? i.keys.filter((k): k is string => typeof k === "string" && KEY_RE.test(k)).slice(0, 3) : [];
    const metric = metricOf(i.metric);
    const variants: Variant[] = (Array.isArray(i.variants) ? i.variants : []).flatMap((v) => {
      if (!v || typeof v !== "object") return [];
      const vv = v as Record<string, unknown>;
      const name = typeof vv.name === "string" ? vv.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 24) : "";
      const weight = typeof vv.weight === "number" && vv.weight > 0 ? Math.min(100, Math.round(vv.weight)) : 50;
      const values = vv.values && typeof vv.values === "object" && !Array.isArray(vv.values) ? Object.fromEntries(Object.entries(vv.values as Record<string, Json>).filter(([k]) => keys.includes(k))) : {};
      return name && /^[a-z]/.test(name) ? [{ name, weight, values: name === "control" ? {} : values }] : [];
    });
    if (typeof i.title !== "string" || !keys.length || !metric || variants.length < 2 || !variants.some((v) => v.name === "control")) continue;
    if (!variants.some((v) => v.name !== "control" && Object.keys(v.values).length)) continue;
    out.push({
      title: i.title.trim().slice(0, 120),
      hypothesis: typeof i.hypothesis === "string" ? i.hypothesis.trim().slice(0, 600) : "",
      why: typeof i.why === "string" ? i.why.trim().slice(0, 400) : "",
      keys,
      variants: variants.slice(0, 3),
      metric,
    });
  }
  return out;
}

/** One agent run (no tools: everything it needs is in the prompt). Charged through metered-query. */
export async function proposeIdeas(input: IdeaInput): Promise<IdeaDraft[]> {
  let text = "";
  for await (const m of meteredQuery("agent_work", "Live experiment ideas")({
    prompt: ideaPrompt(input),
    options: { model: MODEL, permissionMode: "bypassPermissions", maxTurns: 2, maxBudgetUsd: IDEAS_MAX_USD, persistSession: false, settingSources: [], settings: { disableClaudeAiConnectors: true }, tools: [] },
  })) {
    const msg = m as { type?: string; result?: string; is_error?: boolean };
    if (msg.type === "result" && !msg.is_error) text = msg.result ?? "";
  }
  return parseIdeas(text);
}

export function addIdeas(state: LiveState, drafts: IdeaDraft[], now: Date): { state: LiveState; ideas: Idea[] } {
  const at = now.toISOString();
  let n = state.nextIdea;
  const ideas: Idea[] = drafts.map((d) => ({ ...d, id: `I-${n++}`, createdAt: at, status: "new", experimentId: null }));
  return { state: { ...state, nextIdea: n, ideas: [...ideas, ...state.ideas].slice(0, 60) }, ideas };
}
