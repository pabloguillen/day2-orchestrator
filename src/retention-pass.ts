import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppEntry } from "./apps-registry";
import { createTicket, rankBacklog, withBacklog, type Backlog } from "./backlog";
import { backlogFile } from "./backlog-work";
import { CreditsError } from "./credits";
import { indexRepo } from "./distribution-loops";
import { appKind } from "./field-work";
import { USER_DAY_DAYS, type FieldStore } from "./field-store";
import type { AppProfile } from "./onboarding";
import { ADS_FILENAME, loadAds } from "./ads/autopilot";
import { parseTag, retentionFrom } from "./ads/results";
import { BETS_FILENAME, loadBets } from "./growth-bets";
import {
  adPromiseIdea,
  adPromiseTicket,
  addTreatment,
  computeSnapshot,
  historyDays,
  IDENTIFY_KEY,
  identifyTicket,
  loadRetention,
  nextTreatment,
  PRODUCT_TYPES,
  researchDue,
  RETENTION_FILENAME,
  rhythmFromUsage,
  saveRetention,
  TARGET_LABEL,
  treatmentTicket,
  updateTreatments,
  type ResearchInput,
  type RetentionResearch,
  type RetentionSnapshot,
  type Source,
} from "./retention";
import { randomUUID } from "node:crypto";

/**
 * One retention pass for an app (called by the growth autopilot):
 * snapshot → identify ticket if nobody is identified → measure live
 * treatments (undo what hurts) → research leading apps (every 60 days) →
 * ticket the next treatment for the biggest leak.
 */

export type RetentionDeps = {
  store: FieldStore;
  research: (input: ResearchInput) => Promise<{ result: Omit<RetentionResearch, "id" | "at" | "credits"> | null; credits: number }>;
};

export type RetentionReport = { snapshot: RetentionSnapshot | null; researched: boolean; ticketsCreated: string[]; undone: string[]; skipped: string[] };

/** Snapshots are recomputed at most this often. */
export const SNAPSHOT_EVERY_MS = 6 * 3_600_000;

const SENDERS = [
  "expo-notifications",
  "@react-native-firebase/messaging",
  "firebase-admin",
  "onesignal",
  "react-native-onesignal",
  "web-push",
  "@novu/node",
  "resend",
  "nodemailer",
  "@sendgrid/mail",
  "postmark",
  "mailgun.js",
  "@aws-sdk/client-ses",
  "@knocklabs/node",
  "@customerio/node",
];

function senders(repoPath: string): string[] {
  const p = join(repoPath, "package.json");
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf-8");
  return SENDERS.filter((s) => text.includes(`"${s}"`));
}

const RETENTION_CODE = /(notif|push|remind|email|mail|digest|streak|welcome|onboard|lifecycle)/i;

function excerpts(repoPath: string): Array<{ file: string; text: string }> {
  const repo = indexRepo(repoPath);
  return repo.files
    .filter((f) => RETENTION_CODE.test(f) && /\.(t|j)sx?$/.test(f) && !/(test|spec|\.d\.ts|day2\/)/.test(f))
    .slice(0, 6)
    .map((file) => {
      const text = repo.read(file);
      return { file, text: text.length > 4000 ? `${text.slice(0, 4000)}\n… (trimmed)` : text };
    });
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export async function retentionPass(
  app: AppEntry,
  profile: AppProfile,
  deps: RetentionDeps,
  log: (text: string, credits?: number) => void,
  now: Date,
): Promise<RetentionReport> {
  const report: RetentionReport = { snapshot: null, researched: false, ticketsCreated: [], undone: [], skipped: [] };
  const kind = appKind(app.repoPath);
  if (kind !== "web" && kind !== "react-native") return report;
  const path = resolve(app.repoPath, RETENTION_FILENAME);
  let file = loadRetention(path);
  const productType = file.research[0]?.productType ?? null;

  // 1. Who is where. The whole pass runs every few hours, not every tick:
  // reading every user's activity is the expensive part.
  const prev = await deps.store.retention(app.id);
  if (prev && now.getTime() - Date.parse(prev.at) < SNAPSHOT_EVERY_MS) {
    report.snapshot = prev;
    return report;
  }
  const days = Math.min(USER_DAY_DAYS, historyDays("monthly"));
  const since = new Date(now.getTime() - days * 86_400_000);
  const activity = await deps.store.activity(app.id, dayOf(since));
  // Where each user first came from: day2's ads (a tag with a platform) or anything else.
  const ads = loadAds(resolve(app.repoPath, ADS_FILENAME));
  const brought = ads.campaigns.length ? retentionFrom(await deps.store.events(app.id, since).catch(() => []), [], now).broughtBy : new Map<string, string>();
  const sourceOf = (user: string): Source => (parseTag(brought.get(user))?.platform ? "ads" : "other");
  const snapshot = computeSnapshot({ ...activity, productType, now, ...(brought.size ? { sourceOf } : {}) });
  await deps.store.setRetention(app.id, snapshot);
  report.snapshot = snapshot;

  const backlogNow = () => withBacklog(backlogFile(app), (b) => ({ backlog: b, result: b }));
  const add = async (input: Parameters<typeof createTicket>[1]) =>
    withBacklog(backlogFile(app), (b: Backlog) => {
      const r = createTicket(b, input, now);
      return { backlog: rankBacklog(r.backlog, now).backlog, result: r.ticket };
    });

  // 2. Nobody identified: the app has to tell day2 who is who first. Only
  // once the field library reports (before that, its install ticket covers it).
  if (snapshot.status === "no_users") {
    const meta = await deps.store.meta(app.id);
    const backlog = await backlogNow();
    if (meta && !backlog.tickets.some((t) => t.source.key === IDENTIFY_KEY)) {
      const t = await add(identifyTicket(kind === "react-native"));
      report.ticketsCreated.push(t.id);
      log(`day2 can't see who comes back yet — added ${t.id} so the app tells it (hashed, never names or emails).`);
    }
    saveRetention(path, file);
    return report;
  }

  // 3. Measure what's live, against its holdout.
  const backlog = await backlogNow();
  const upd = updateTreatments(file, backlog.tickets, activity.users, now, sourceOf);
  file = upd.file;
  for (const d of upd.decided) log(`Measured "${d.name}" (${d.ticketId}) against its holdout: ${d.result.note}`);
  for (const u of upd.undo) {
    const t = await add(u.ticket);
    file = { ...file, treatments: file.treatments.map((x) => (x.id === u.treatment.id ? { ...x, undoTicketId: t.id } : x)) };
    report.undone.push(t.id);
    log(`"${u.treatment.name}" made users less likely to come back — added ${t.id} to remove it.`);
  }

  // 4. How leading apps of this kind keep their users (every 60 days).
  if (researchDue(file, now)) {
    try {
      const r = await deps.research({
        appName: app.name,
        purpose: profile.purpose,
        targetUsers: profile.targetUsers,
        featureMap: profile.featureMap.join(", "),
        usageRhythm: rhythmFromUsage(activity.users, now),
        excerpts: excerpts(app.repoPath),
        senders: senders(app.repoPath),
      });
      if (r.result) {
        file = { ...file, research: [{ id: `rr-${randomUUID().slice(0, 8)}`, at: now.toISOString(), credits: r.credits, ...r.result }, ...file.research] };
        report.researched = true;
        log(
          `Researched how leading ${r.result.category} keep their users (${r.result.leaders.join(", ")}): a ${PRODUCT_TYPES[r.result.productType].label.toLowerCase()} product, ${r.result.ideas.length} cited treatment${r.result.ideas.length === 1 ? "" : "s"}.`,
          r.credits,
        );
      } else log("Couldn't verify how leading apps keep their users this time — day2 changes nothing rather than guess.", r.credits);
    } catch (err) {
      const why = err instanceof CreditsError ? err.message : (err as Error).message;
      log(`Retention research skipped: ${why}`);
      report.skipped.push(`retention research: ${why}`);
    }
  }

  // 5. Ad-brought new users staying clearly less than other new users: the
  // first minutes after an ad are the leak (the ads keep running).
  const bets = loadBets(resolve(app.repoPath, BETS_FILENAME)).bets;
  const adBets = bets.filter((b) => ads.campaigns.some((c) => c.betId === b.id)).map((b) => ({ id: b.id, angle: b.angle, landingPath: b.landingPath ?? null }));
  const promise = adPromiseIdea(file, snapshot, await backlogNow(), adBets);
  if (promise) {
    const t = await add(adPromiseTicket(promise, snapshot));
    file = addTreatment(file, promise, { id: "ads" }, snapshot.rhythm, t.id, now);
    report.ticketsCreated.push(t.id);
    const s = snapshot.newBySource!;
    log(`New users from ads come back ${Math.round(s.ads.rate! * 100)}% of the time, other new users ${Math.round(s.other.rate! * 100)}% — added ${t.id} so the app opens on what each ad promised. Ad-brought users only, 10% held out.`);
    saveRetention(path, file);
    return report;
  }

  // 6. The biggest leak gets the next treatment (new users weigh more while ads buy them).
  const research = file.research[0];
  const paidNew = ads.campaigns.some((c) => c.status === "active");
  const idea = research ? nextTreatment(file, snapshot, await backlogNow(), { paidNew }) : null;
  if (idea && research) {
    const t = await add(treatmentTicket(idea, research, snapshot));
    file = addTreatment(file, idea, research, snapshot.rhythm, t.id, now);
    report.ticketsCreated.push(t.id);
    log(`${TARGET_LABEL[idea.target]} are where most users are lost (${snapshot.lost[idea.target]} last period) — added ${t.id}: ${idea.name}, as ${idea.leaders.map((l) => l.app).join(" and ")} do. 10% are held out to measure it.`);
  }
  saveRetention(path, file);
  return report;
}
