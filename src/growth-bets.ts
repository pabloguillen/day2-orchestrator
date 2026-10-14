import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { EventLike } from "./metrics/types";
import { evaluateProportionExperiment } from "./experiments";
import type { NewTicketInput, Ticket } from "./backlog";

/**
 * Growth experiments that run from the ad to the product ("bets").
 *
 * An ad tool tests an ad and reads clicks. A bet tests an *idea* end to end:
 * one angle (the message), the page in the app built for it (a backlog
 * ticket day2 builds as a PR), one tracked link to run it with (an ad, a
 * post, an email), and a verdict measured in the product — did the people
 * it brought sign up and reach first value more often than everyone else?
 *
 * Measurement reads the app's usage events (docs/growth-events.md): a
 * device's first event carries `acquisition.campaignId = <bet id>` when it
 * arrived through the bet's link. Outcomes are compared with everyone who
 * arrived another way in the same period, using the same Beta-posterior
 * comparison experiments.ts uses, and only called once both sides have
 * enough people.
 */

export const BETS_FILENAME = "day2-growth-bets.json";

export type BetMetric = "signup" | "activation";
export type BetStatus = "building" | "live" | "stopped";

export type Bet = {
  id: string; // "B-1"
  title: string;
  /** The message/idea being tested, in plain words. */
  angle: string;
  audience: string;
  /** Where the link runs: "Meta ads", "Reddit post", "newsletter"… */
  channel: string;
  metric: BetMetric;
  /** The page in the app built for this angle. */
  landingPath: string;
  ticketId: string | null;
  /** Where the idea came from, when it came from market research. */
  source: { researchRunId: string; findingId: string; competitor: string } | null;
  status: BetStatus;
  createdAt: string;
  liveAt: string | null;
  stoppedAt: string | null;
};

export type BetsFile = { nextNumber: number; bets: Bet[] };

export function loadBets(path: string): BetsFile {
  if (!existsSync(path)) return { nextNumber: 1, bets: [] };
  const p = JSON.parse(readFileSync(path, "utf-8")) as Partial<BetsFile>;
  return { nextNumber: p.nextNumber ?? 1, bets: Array.isArray(p.bets) ? p.bets : [] };
}

export function saveBets(path: string, file: BetsFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(tmp, path);
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "offer";

export type NewBet = {
  title: string;
  angle: string;
  audience?: string;
  channel: string;
  metric?: BetMetric;
  source?: Bet["source"];
};

export function validateNewBet(raw: unknown): { ok: true; bet: NewBet } | { ok: false; reason: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof r[k] === "string" ? (r[k] as string).trim().slice(0, max) : "");
  const title = str("title", 120);
  const angle = str("angle", 600);
  const channel = str("channel", 60);
  if (!title) return { ok: false, reason: "Give the experiment a short name." };
  if (!angle) return { ok: false, reason: "Describe the idea to test — the message people will see." };
  if (!channel) return { ok: false, reason: "Say where it will run (for example: Meta ads, a Reddit post, your newsletter)." };
  const metric = r.metric === undefined ? "activation" : r.metric;
  if (metric !== "signup" && metric !== "activation") return { ok: false, reason: "metric must be signup or activation." };
  let source: Bet["source"] = null;
  if (r.source && typeof r.source === "object") {
    const s = r.source as Record<string, unknown>;
    if (typeof s.researchRunId === "string" && typeof s.findingId === "string" && typeof s.competitor === "string") {
      source = { researchRunId: s.researchRunId, findingId: s.findingId, competitor: s.competitor.slice(0, 80) };
    }
  }
  return { ok: true, bet: { title, angle, audience: str("audience", 200), channel, metric, source } };
}

/** Adds a bet (status "building" until its page ships). */
export function addBet(file: BetsFile, input: NewBet, now: Date): { file: BetsFile; bet: Bet } {
  const id = `B-${file.nextNumber}`;
  const taken = new Set(file.bets.map((b) => b.landingPath));
  let path = `/go/${slugify(input.title)}`;
  if (taken.has(path)) path = `${path}-${file.nextNumber}`;
  const bet: Bet = {
    id,
    title: input.title,
    angle: input.angle,
    audience: input.audience ?? "",
    channel: input.channel,
    metric: input.metric ?? "activation",
    landingPath: path,
    ticketId: null,
    source: input.source ?? null,
    status: "building",
    createdAt: now.toISOString(),
    liveAt: null,
    stoppedAt: null,
  };
  return { file: { nextNumber: file.nextNumber + 1, bets: [bet, ...file.bets] }, bet };
}

/** The tracked link to run the bet with. */
export function betLink(bet: Bet, appBaseUrl: string | undefined): string | null {
  if (!appBaseUrl) return null;
  return `${appBaseUrl.replace(/\/+$/, "")}${bet.landingPath}?d2=${encodeURIComponent(bet.id)}`;
}

/** The backlog ticket for the bet's page in the app. */
export function betTicket(bet: Bet): NewTicketInput {
  return {
    title: `Experiment ${bet.id}: build the page for "${bet.title}"`,
    type: "feature",
    description: [
      `day2 is testing an idea end to end. Build a focused landing page for it at ${bet.landingPath}.`,
      ``,
      `The idea: ${bet.angle}`,
      bet.audience ? `For: ${bet.audience}` : "",
      `It will run on: ${bet.channel}`,
      ``,
      `The page leads with this message, shows the product doing exactly what it promises (real screens, no invented claims), and has one clear call to sign up or start.`,
      `Measurement: when someone arrives with ?d2=${bet.id}, record it as their acquisition campaign (campaignId "${bet.id}") on their first day2 event, and keep it through sign-up (see day2's usage events: docs/growth-events.md).`,
    ]
      .filter((l) => l !== "")
      .join("\n"),
    doneWhen: [
      `${bet.landingPath} exists, leads with the idea, and has one call to sign up or start`,
      `Visiting ${bet.landingPath}?d2=${bet.id} records campaignId "${bet.id}" on the visitor's first event`,
      "The page has its own title, description and link preview",
    ],
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: `bet:${bet.id}` },
    actor: "day2",
    createdNote: `Part of experiment ${bet.id}.`,
  };
}

/** Status follows the page's ticket: live once it's done. */
export function syncBetStatus(bet: Bet, ticket: Pick<Ticket, "state" | "doneAt" | "updatedAt"> | undefined): Bet {
  if (bet.status !== "building" || !ticket || ticket.state !== "done") return bet;
  return { ...bet, status: "live", liveAt: ticket.doneAt ?? ticket.updatedAt };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type BetVerdict =
  | { state: "no_data"; note: string }
  | {
      state: "collecting" | "better" | "worse" | "no_difference";
      betPeople: number;
      betRate: number | null;
      othersPeople: number;
      othersRate: number | null;
      /** Probability the bet's people do better than everyone else. */
      probabilityBetter: number | null;
      note: string;
    };

export const ACTIVATION_EVENT = "activated";
export const SIGNUP_EVENT = "signup";

/** Deterministic RNG (mulberry32) seeded by the bet id — the same data
 * always gives the same verdict. */
function seeded(seedText: string): () => number {
  let a = 0;
  for (const ch of seedText) a = (Math.imul(a ^ ch.charCodeAt(0), 2654435761) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Compares people who arrived through the bet's link with everyone who
 * arrived another way since the bet went live: did they sign up / reach
 * first value more often? `events` may be null when the app doesn't report
 * usage events to day2.
 */
export function measureBet(bet: Bet, events: EventLike[] | null, opts: { minPerSide?: number } = {}): BetVerdict {
  if (events === null) return { state: "no_data", note: "This app doesn't report usage events to day2 yet, so results can't be measured. The page's ticket adds it." };
  if (bet.status === "building" || !bet.liveAt) return { state: "no_data", note: "Results start once the page is live." };
  const since = bet.liveAt;
  const until = bet.stoppedAt ?? "9999";
  const byDevice = new Map<string, EventLike[]>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId);
    if (list) list.push(e);
    else byDevice.set(e.deviceId, [e]);
  }
  const outcomeEvent = bet.metric === "signup" ? SIGNUP_EVENT : ACTIVATION_EVENT;
  const betOutcomes: boolean[] = [];
  const otherOutcomes: boolean[] = [];
  for (const list of byDevice.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const first = list[0]!;
    // Only people who first arrived while the bet was running.
    if (first.at < since || first.at > until) continue;
    const reached = list.some((e) => e.type === outcomeEvent);
    if (first.acquisition?.campaignId === bet.id) betOutcomes.push(reached);
    else otherOutcomes.push(reached);
  }
  const rate = (o: boolean[]) => (o.length ? o.filter(Boolean).length / o.length : null);
  const what = bet.metric === "signup" ? "signed up" : "reached first value";
  const base = { betPeople: betOutcomes.length, betRate: rate(betOutcomes), othersPeople: otherOutcomes.length, othersRate: rate(otherOutcomes) };
  const cmp = evaluateProportionExperiment(otherOutcomes, betOutcomes, seeded(bet.id), opts.minPerSide !== undefined ? { minNPerArm: opts.minPerSide } : {});
  if (!cmp.sufficientPower) {
    return {
      state: "collecting",
      ...base,
      probabilityBetter: null,
      note: `Collecting: ${base.betPeople} people came through this experiment so far; day2 calls it once both sides have enough people.`,
    };
  }
  const p = cmp.posteriorProbabilityTreatmentBetter;
  const rates = `${pct(base.betRate!)} of people from this experiment ${what}, vs ${pct(base.othersRate!)} of everyone else`;
  if (p >= 0.9) return { state: "better", ...base, probabilityBetter: p, note: `Working: ${rates}. Worth putting more behind it.` };
  if (p <= 0.1) return { state: "worse", ...base, probabilityBetter: p, note: `Not working: ${rates}. Stop it or change the idea.` };
  return { state: "no_difference", ...base, probabilityBetter: p, note: `No clear difference yet: ${rates}.` };
}
