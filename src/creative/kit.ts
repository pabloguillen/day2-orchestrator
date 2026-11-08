import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppEntry } from "../apps-registry";
import { ensureLocalSecretsKey } from "../ads/connections";
import type { VideoJob, VideoProvider } from "../ads/providers/video";
import { authorize, creditsForCost, recordCharge, type CreditStore } from "../credits";
import { dataDir } from "../day2-paths";
import { db } from "../db";
import { loadAllocatorState, type AllocatorState, type Arm } from "../growth-allocator";
import { serverMode } from "../tenant";
import { operatorCreds, TOOLS } from "./catalog";
import { candidates, pickTool, type Candidate, type Purpose, type ToolState } from "./select";
import { safeDownload, type MediaKind } from "./download";
import { adjustUsage, CapError, CREATOR_TOOLS_FILENAME, dbCreatorKeys, fileCreatorKeys, loadCreatorSettings, reserveUsage, settingOf, updateCreatorSettings, usedThisMonth, type CreatorKeyStore, type OwnKey } from "./store";
import { CAPABILITY_LABEL, type CreativeJob, type MadeWith, type ToolDeps } from "./types";

/**
 * The creator tools one app can use right now, for Posts or Ads: pick the
 * best tool for a job, run it, bring the file onto day2's disk, and keep
 * count of what day2's account used (for the monthly caps).
 *
 * On day2's account each job: reserves its estimate against the tool's cap
 * (fresh settings, under a lock — refused if it wouldn't fit), checks the
 * customer has the credits, runs, then settles the reservation to the real
 * cost (or releases it on failure) and — with `billing` — charges the
 * credits right away, once per job (charge id per provider job). Without
 * `billing` the caller bills `billedUsd`. Nothing is billed or counted on
 * the owner's own account.
 */

export type KitRun = {
  file: string;
  mime: string;
  durationSec?: number;
  aiPerson: boolean;
  /** What the customer pays for it (0 on their own account). */
  billedUsd: number;
  /** Already charged to the credits ledger by the kit (don't bill again). */
  charged: boolean;
  costUsd: number;
  credits: number;
  made: MadeWith;
  providerJobId: string;
};
export type KitBilling = { credits: CreditStore; appId: string; appName: string };

export type CreatorKit = {
  purpose: Purpose;
  candidates(job: CreativeJob): Candidate[];
  pick(job: CreativeJob, ctx?: { allocator?: AllocatorState; arm?: Arm; rng?: () => number }): Candidate | null;
  run(c: Candidate, job: CreativeJob, dir?: string): Promise<KitRun>;
};

/** Names of real people who must never be asked for (a backstop to the rules below). */
const DENY_NAMES = ["elon musk", "taylor swift", "donald trump", "barack obama", "joe biden", "mrbeast", "mr beast", "cristiano ronaldo", "lionel messi", "kim kardashian", "beyonce", "beyoncé", "rihanna", "drake", "olaf scholz", "angela merkel", "billie eilish", "selena gomez", "khaby lame"];
const PERSON_WORDS = /\b(celebrit(y|ies)|famous|actor|actress|singer|rapper|musician|influencer|youtuber|tiktoker|streamer|politician|president|chancellor|athlete|footballer|soccer player|royal|lookalike|look-alike|deepfake|likeness|in the style of|portrait of|face of|resembl\w*)\b/i;
/** Two capitalised words in a row that don't start a sentence: probably a person's name ("… with Taylor Swift"). Pure. */
export function looksLikeName(text: string): boolean {
  for (const sentence of text.split(/[.!?:;\n]+/)) {
    const words = sentence.trim().split(/[\s,()"']+/).filter(Boolean);
    for (let k = 1; k + 1 < words.length; k++) if (/^\p{Lu}\p{Ll}+$/u.test(words[k]!) && /^\p{Lu}\p{Ll}+$/u.test(words[k + 1]!)) return true;
  }
  return false;
}

/**
 * Words that must never be sent to a generator: handles, links (any domain,
 * shorteners included), emails, or a real person. `scene` prompts (generated
 * clips, images) also refuse anything that names or describes a person;
 * `allow` lists names that are fine (the app's own name). Pure.
 */
export function promptProblem(text: string, opts: { scene?: boolean; allow?: string[] } = {}): string | null {
  if (/(^|[\s(])@[a-z0-9_.]{2,}/i.test(text)) return "it names an @handle";
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) return "it contains an email address";
  if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(text) || /\bwww\./i.test(text) || /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d+)?(?:\/\S*)?(?=[\s,;)"'!?]|\.(?:\s|$)|$)/i.test(text)) return "it contains a web address";
  const lower = text.toLowerCase();
  if (DENY_NAMES.some((n) => lower.includes(n))) return "it names a real person";
  if (!opts.scene) return null;
  if (PERSON_WORDS.test(text)) return "it asks for a real or recognizable person, or their likeness or style";
  // The owner's own Brand DNA wording (style words are often capitalised) skips only the name heuristic.
  let rest = text.replace(/<<<BRAND LOOK[^>]*>>>[\s\S]*?<<<END>>>/g, " ");
  for (const a of opts.allow ?? []) if (a.trim()) rest = rest.split(a).join(" ");
  if (looksLikeName(rest)) return "it seems to name a person (two capitalised words) — scenes never show real people";
  return null;
}

/** Added to every scene prompt: the tools' content policies and day2's own rules. */
export const SCENE_RULES = "No real or recognizable people: no people, faces or hands at all; no added text, captions, logos or brand names; nothing violent, sexual or unsafe; suitable for ages 13+.";

/** Added to every demo-cast profile photo prompt (ImageJob subject "fictional_person"). */
export const FICTIONAL_PERSON_RULES = "The person is invented and must not look like any real, famous or recognizable individual. A clearly adult person (20s), never a child or teenager. Fully clothed, friendly, everyday setting. No text, letters, captions, logos, brand names or watermarks; nothing violent, sexual or unsafe.";

const isFictionalPerson = (job: CreativeJob) => job.capability === "image" && job.subject === "fictional_person";

const KIND: Record<CreativeJob["capability"], MediaKind> = { presenter_video: "video", generated_video: "video", image: "image", voice: "audio", music: "audio" };

const EXT: Record<string, string> = { "video/mp4": ".mp4", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav" };

export function creatorKit(i: { purpose: Purpose; states: ToolState[]; deps?: ToolDeps; settingsPath?: string; now?: () => Date; creditsFor?: (usd: number) => number; billing?: KitBilling; lookup?: (host: string) => Promise<string[]> }): CreatorKit {
  const now = i.now ?? (() => new Date());
  const creditsFor = i.creditsFor ?? ((u: number) => creditsForCost(u, "content_generation"));
  const doFetch = i.deps?.fetch ?? fetch;
  const kit: CreatorKit = {
    purpose: i.purpose,
    candidates: (job) => candidates(i.states, i.purpose, job, creditsFor),
    pick: (job, ctx) => pickTool(kit.candidates(job), ctx),
    async run(c, job, dir = mkdtempSync(join(tmpdir(), "day2-creative-"))) {
      const person = isFictionalPerson(job);
      const scene = !person && (job.capability === "generated_video" || job.capability === "image");
      const words = job.capability === "presenter_video" ? job.script : job.capability === "voice" ? job.text : job.prompt;
      // A demo-cast photo describes an invented person on purpose; it still may not name anyone (handles, links, real names, "two capitalised words").
      const problem = promptProblem(words, { scene, allow: "appName" in job ? [job.appName] : [] }) ?? (person && looksLikeName(words.replace(/\b(?:Photorealistic|Natural|Shot|Daylight)\b/g, "")) ? "it seems to name a person" : null);
      if (problem) throw new Error(`Not sent to ${c.name}: ${problem}.`);
      const safe: CreativeJob = scene ? { ...job, prompt: `${job.prompt.trim()}\n${SCENE_RULES}` } : person && job.capability === "image" ? { ...job, prompt: `${job.prompt.trim()}\n${FICTIONAL_PERSON_RULES}` } : job;
      const st = i.states.find((s) => s.def.id === c.id);
      const day2 = c.account === "day2";
      // 1. Reserve the estimate against the cap, from the settings as they are now.
      const estUsd = day2 ? c.def.client(c.creds).estimateUsd(job) : 0;
      const estCredits = day2 ? creditsFor(estUsd) : 0;
      let reserved = 0;
      if (day2) {
        if (i.settingsPath) reserveUsage(i.settingsPath, c.id, estCredits, now());
        else if (st && st.usedCredits + estCredits > st.setting.capCredits) throw new CapError(`over this month's cap for ${c.id}`);
        reserved = estCredits;
        if (st) st.usedCredits += estCredits;
      }
      const release = (credits: number) => {
        if (!credits) return;
        if (i.settingsPath) updateCreatorSettings(i.settingsPath, (s) => adjustUsage(s, c.id, -credits, now()));
        if (st) st.usedCredits = Math.max(0, st.usedCredits - credits);
      };
      try {
        // 2. The customer has the credits for it.
        if (day2 && i.billing && estUsd > 0) {
          const ok = await authorize(i.billing.credits, { appId: i.billing.appId, appName: i.billing.appName, service: "content_generation", maxCostUsd: estUsd });
          if (!ok.ok) throw new Error(`Not made with ${c.name}: ${ok.reason}`);
        }
        // 3. Run, and bring the file onto day2's disk.
        const out = await c.def.client(c.creds, i.deps).generate(safe);
        const file = join(dir, `${c.id}-${out.providerJobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "out"}${EXT[out.mime] ?? ""}`);
        if (out.bytes) {
          if (out.bytes.byteLength > 200 * 1024 * 1024) throw new Error(`${c.name} returned a file that's too large.`);
          writeFileSync(file, out.bytes);
        } else if (out.url) await safeDownload(out.url, file, { tool: c.id, kind: KIND[job.capability], fetch: i.deps?.fetch, lookup: i.lookup });
        else throw new Error(`${c.name} returned nothing to download.`);
        // 4. Settle the reservation to what it really cost, and bill it now (once per job).
        const credits = day2 ? creditsFor(out.costUsd) : 0;
        if (day2) {
          release(reserved - credits);
          reserved = 0;
        }
        let charged = false;
        if (day2 && i.billing && out.costUsd > 0) {
          await recordCharge(i.billing.credits, { id: `creator:${i.billing.appId}:${c.id}:${out.providerJobId}`, appId: i.billing.appId, service: "content_generation", costUsd: out.costUsd, description: `${CAPABILITY_LABEL[job.capability].replace(/s$/, "")} (${c.name})` });
          charged = true;
        }
        return { file, mime: out.mime, durationSec: out.durationSec, aiPerson: out.aiPerson || person, billedUsd: day2 ? out.costUsd : 0, charged, costUsd: out.costUsd, credits, made: { tool: c.id, name: c.name, capability: job.capability, account: c.account }, providerJobId: out.providerJobId };
      } catch (err) {
        release(reserved);
        throw err;
      }
    },
  };
  return kit;
}

// ---------------------------------------------------------------- runtime

export function creatorKeys(): CreatorKeyStore {
  if (serverMode() === "accounts") return dbCreatorKeys(db());
  ensureLocalSecretsKey(join(dataDir(), ".day2-secrets-key"));
  return fileCreatorKeys(join(dataDir(), ".day2-creator-keys.json"));
}

export const creatorSettingsPath = (app: Pick<AppEntry, "repoPath">) => resolve(app.repoPath, CREATOR_TOOLS_FILENAME);

/** Every tool's state for an app: settings, the owner's keys (app first, then workspace), day2's account, use this month. */
export async function toolStates(accountId: string, app: Pick<AppEntry, "id" | "repoPath">, opts: { env?: Record<string, string | undefined>; keys?: CreatorKeyStore; now?: Date } = {}): Promise<Array<ToolState & { ownScope: "app" | "workspace" | null }>> {
  const settings = loadCreatorSettings(creatorSettingsPath(app));
  const ops = operatorCreds(opts.env ?? process.env);
  const keys: OwnKey[] = await (opts.keys ?? creatorKeys()).forApp(accountId, app.id).catch(() => []);
  const now = opts.now ?? new Date();
  return TOOLS.map((def) => {
    const own = keys.find((k) => k.tool === def.id && k.appId === app.id) ?? keys.find((k) => k.tool === def.id && k.appId === null) ?? null;
    return { def, setting: settingOf(settings, def.id), own, ownScope: own ? (own.appId ? "app" : "workspace") : null, operator: ops[def.id] ?? null, usedCredits: usedThisMonth(settings, def.id, now) };
  });
}

export async function creatorKitFor(accountId: string, app: Pick<AppEntry, "id" | "repoPath">, purpose: Purpose, opts: { deps?: ToolDeps; billing?: KitBilling } = {}): Promise<CreatorKit> {
  return creatorKit({ purpose, states: await toolStates(accountId, app), deps: opts.deps, billing: opts.billing, settingsPath: creatorSettingsPath(app) });
}

/**
 * A kit's best tool for presenter or generated video, as the ads pipeline's
 * VideoProvider: `estimateUsd` and `costUsd` are what the customer is billed
 * (0 on their own account), and the file is already on day2's disk.
 */
export function kitVideoProvider(kit: CreatorKit, capability: "presenter_video" | "generated_video", ctx: { allocator?: AllocatorState; arm?: Arm; rng?: () => number } = {}): VideoProvider | null {
  const toJob = (j: VideoJob, appName = j.appName): CreativeJob =>
    capability === "presenter_video"
      ? { capability, script: j.script ?? "", ratio: j.ratio, language: j.language, appName }
      : { capability, prompt: j.prompt ?? "", ratio: j.ratio, durationSec: j.durationSec, imageUrl: j.imageUrl ?? "data:image/jpeg;base64,", appName };
  const sample: VideoJob = capability === "presenter_video" ? { kind: "avatar_ad", ratio: "9:16", durationSec: 30, script: "x ".repeat(60), appName: "app" } : { kind: "image_to_video", ratio: "9:16", durationSec: 5, imageUrl: "data:image/jpeg;base64,", prompt: "x", appName: "app" };
  const c = kit.pick(toJob(sample), ctx);
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    kinds: capability === "presenter_video" ? ["avatar_ad"] : ["image_to_video"],
    estimateUsd: (job) => (c.account === "own" ? 0 : c.def.client(c.creds).estimateUsd(toJob(job))),
    async generate(job) {
      const r = await kit.run(c, toJob(job));
      return { url: "", file: r.file, durationSec: r.durationSec, aiPerson: r.aiPerson, costUsd: r.billedUsd, billed: r.charged, providerJobId: r.providerJobId, account: c.account };
    },
  };
}

/** The allocator arms ads record per format (src/ads/learnings.ts recordInAllocator). */
const ADS_ARM: Record<"presenter_video" | "generated_video", Arm> = {
  presenter_video: { channel: "paid_ads" as Arm["channel"], assetType: "video", videoFormat: "ugc", formatTag: "presenter" },
  generated_video: { channel: "paid_ads" as Arm["channel"], assetType: "video", videoFormat: "motion_graphics", formatTag: "generated" },
};

/** The ads pipeline's presenter and generated-video providers for an app: the best creator tool for each, or null. */
export async function adsVideoProviders(accountId: string, app: Pick<AppEntry, "id" | "repoPath" | "name">, credits?: CreditStore): Promise<{ presenter: VideoProvider | null; generated: VideoProvider | null }> {
  const kit = await creatorKitFor(accountId, app, "ads", credits ? { billing: { credits, appId: app.id, appName: app.name } } : {});
  const allocator = loadAllocatorState(resolve(app.repoPath, "day2-allocator-state.json"));
  return {
    presenter: kitVideoProvider(kit, "presenter_video", { allocator, arm: ADS_ARM.presenter_video }),
    generated: kitVideoProvider(kit, "generated_video", { allocator, arm: ADS_ARM.generated_video }),
  };
}
