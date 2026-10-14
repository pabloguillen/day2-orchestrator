import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Backlog, NewTicketInput, Ticket, TicketType } from "./backlog";

/**
 * Growth built into the app itself — the distribution an ad tool can't
 * give you, because it lives in the product's code: link previews that make
 * every share an ad, invite/referral loops, pages search engines and AI
 * assistants can find and cite.
 *
 * day2 checks the app's own code for each (a static scan: cheap, no agent,
 * no credits), says what's there and what's missing, and turns a missing
 * one into a backlog ticket that day2 builds like any other — failing test
 * first where it applies, as a PR the owner approves.
 *
 * Each check looks for concrete evidence and names the file it found;
 * "missing" means none was found, said plainly as "not found" in the UI.
 */

export type LoopId = "share_preview" | "share_action" | "referral" | "seo_pages" | "sitemap" | "ai_findability" | "review_prompt";

export type LoopStatus = "present" | "missing" | "not_applicable";

export type LoopCheck = {
  id: LoopId;
  name: string;
  /** Why it grows the app, in one plain sentence. */
  why: string;
  status: LoopStatus;
  /** Where the evidence was found (repo-relative), when present. */
  evidence: string | null;
  /** The backlog ticket building it, when one exists. */
  ticket: { id: string; state: Ticket["state"] } | null;
};

type Definition = {
  id: LoopId;
  name: string;
  why: string;
  /** Mobile-only checks are "not applicable" for web apps. */
  mobileOnly?: boolean;
  find: (repo: RepoIndex) => string | null;
  ticket: { title: string; type: TicketType; description: string; doneWhen: string[] };
};

// ---------------------------------------------------------------------------
// Repo index (bounded; skips dependencies and build output)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".output", ".vercel", "coverage", ".turbo", ".expo", "ios", "android", "vendor", "managed-repos"]);
const TEXT_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|html?|md|mdx|json|txt|xml|ya?ml|php|rb|py|go)$/i;
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 400_000;

export type RepoIndex = {
  root: string;
  files: string[]; // repo-relative
  read: (rel: string) => string;
  isMobile: boolean;
};

export function indexRepo(root: string): RepoIndex {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (files.length >= MAX_FILES || depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= MAX_FILES) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !(name.startsWith(".") && name !== ".well-known")) walk(full, depth + 1);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES && TEXT_EXT.test(name)) {
        files.push(relative(root, full));
      }
    }
  };
  walk(root, 0);
  const cache = new Map<string, string>();
  const read = (rel: string) => {
    let c = cache.get(rel);
    if (c === undefined) {
      try {
        c = readFileSync(join(root, rel), "utf-8");
      } catch {
        c = "";
      }
      cache.set(rel, c);
    }
    return c;
  };
  const pkg = existsSync(join(root, "package.json")) ? read("package.json") : "";
  const isMobile = /"(react-native|expo|@capacitor\/core|@ionic\/react)"/.test(pkg) || existsSync(join(root, "pubspec.yaml"));
  return { root, files, read, isMobile };
}

const isSource = (f: string) => /\.(tsx?|jsx?|mjs|vue|svelte|astro|html?|php|rb|py|go)$/i.test(f) && !/(\.test\.|\.spec\.|__tests__|\/e2e\/)/.test(f);

/** First file (by the predicate on name) whose content matches. */
function grep(repo: RepoIndex, re: RegExp, filter: (f: string) => boolean = isSource): string | null {
  for (const f of repo.files) {
    if (!filter(f)) continue;
    if (re.test(repo.read(f))) return f;
  }
  return null;
}

const fileNamed = (repo: RepoIndex, re: RegExp) => repo.files.find((f) => re.test(f)) ?? null;

// ---------------------------------------------------------------------------
// The loops
// ---------------------------------------------------------------------------

export const LOOPS: Definition[] = [
  {
    id: "share_preview",
    name: "Link previews",
    why: "Every time someone shares a link to your app, a good title, description and image turn it into a free ad.",
    find: (r) => grep(r, /og:(title|image)|property=["']og:|openGraph\s*[:=]|twitter:card/i),
    ticket: {
      title: "Add link previews (Open Graph and Twitter cards) to the app's pages",
      type: "improvement",
      description:
        "Shared links to the app show no proper preview. Add Open Graph and Twitter card tags (title, description, image) to every public page, with a 1200×630 preview image in the app's style. Pages with their own content (e.g. a shared item) should get their own title and description.",
      doneWhen: [
        "Every public page has og:title, og:description, og:image and twitter:card tags",
        "Sharing the home page in a chat app shows the title, description and image",
        "A test checks the tags are present on the home page",
      ],
    },
  },
  {
    id: "share_action",
    name: "Share button",
    why: "Letting people share what they made or found inside the app, in one tap, is the cheapest acquisition there is.",
    find: (r) => grep(r, /navigator\.share\s*\(|Share\.share\s*\(|react-share|share_target|copyToClipboard\([^)]*(url|link)/i),
    ticket: {
      title: "Let people share from inside the app",
      type: "feature",
      description:
        "There's no way to share from inside the app. At the moment someone gets value (a finished result, something worth showing), offer a Share action: the native share sheet where available (navigator.share), otherwise copy-link. The shared link should open a page with a good preview and a clear way to try the app.",
      doneWhen: [
        "A Share action appears at the app's key moment of value",
        "It uses the native share sheet when available and copy-link otherwise",
        "The shared link opens a public page with a link preview and a call to try the app",
      ],
    },
  },
  {
    id: "referral",
    name: "Invites and referrals",
    why: "Users bringing users compounds: each invite costs nothing and converts far better than an ad.",
    find: (r) => grep(r, /\b(referral|referralCode|referral_code|referred_by|referredBy|inviteCode|invite_code|inviteLink|invite_link|invitations?)\b/i),
    ticket: {
      title: "Add invites: let users bring a friend or teammate",
      type: "feature",
      description:
        "The app has no invite or referral flow. Add a simple one: each user gets a personal invite link; people who join through it are tracked (who invited whom). If the app has a paid plan, offer a reward both sides understand (for example a free month); otherwise a clear reason to invite (shared use, collaboration).",
      doneWhen: [
        "Each user can copy a personal invite link",
        "Sign-ups through an invite link are recorded with the inviter",
        "The invite is offered at a natural moment, not only in settings",
      ],
    },
  },
  {
    id: "seo_pages",
    name: "Pages people search for",
    why: "Public pages that answer what your users search for (guides, templates, comparisons) bring visitors every day without ads.",
    find: (r) =>
      fileNamed(r, /(^|\/)(blog|guides?|learn|templates?|compare|alternatives?|vs|use-cases?|resources)(\/|\.|$)/i) ??
      grep(r, /generateStaticParams|getStaticPaths/),
    ticket: {
      title: "Add public pages that answer what users search for",
      type: "feature",
      description:
        "The app has no public, search-friendly content. Add a small section (for example /guides) with pages answering the questions the app's users search for, each ending in a way to try the app. Start with 3 pages day2 drafts from the app profile; each needs a real title, description and link preview.",
      doneWhen: [
        "A public section with at least 3 pages exists and is linked from the home page",
        "Each page has its own title, description and link preview",
        "The pages are in the sitemap",
      ],
    },
  },
  {
    id: "sitemap",
    name: "Sitemap and robots.txt",
    why: "Tells search engines and AI crawlers which pages exist, so new pages get found in days, not months.",
    find: (r) => fileNamed(r, /(^|\/)sitemap(\.xml|\.(t|j)sx?|\.xml\.(t|j)s)$/i) ?? grep(r, /sitemap/i, (f) => /(next|nuxt|astro|vite|svelte)\.config/.test(f)),
    ticket: {
      title: "Add a sitemap and robots.txt",
      type: "task",
      description: "The app has no sitemap. Add /sitemap.xml listing every public page (generated, so new pages appear automatically) and a robots.txt that points to it and keeps private areas (accounts, admin) out of search.",
      doneWhen: ["/sitemap.xml lists every public page", "/robots.txt points to the sitemap and excludes private areas"],
    },
  },
  {
    id: "ai_findability",
    name: "Findable by AI assistants",
    why: "More people ask ChatGPT, Claude or Perplexity than search; a clear llms.txt and structured data help them recommend your app accurately.",
    find: (r) => fileNamed(r, /(^|\/)llms(-full)?\.txt$/i) ?? grep(r, /application\/ld\+json/i),
    ticket: {
      title: "Make the app easy for AI assistants to understand and recommend",
      type: "improvement",
      description:
        "There's no llms.txt and no structured data. Add /llms.txt (what the app does, for whom, key pages, pricing) and schema.org structured data (SoftwareApplication or WebApplication, with name, description, category and offers) on the home page. Keep both factual — taken from the app profile, no claims the app can't back.",
      doneWhen: ["/llms.txt describes the app, its audience, key pages and pricing", "The home page has valid SoftwareApplication/WebApplication JSON-LD"],
    },
  },
  {
    id: "review_prompt",
    name: "App store review prompt",
    why: "Ratings decide app store ranking; asking happy users at the right moment lifts both.",
    mobileOnly: true,
    find: (r) => grep(r, /requestReview|StoreReview|in_app_review|SKStoreReviewController|InAppReview/i),
    ticket: {
      title: "Ask happy users for an app store rating at the right moment",
      type: "feature",
      description:
        "The app never asks for a rating. Use the platform's in-app review prompt (StoreKit on iOS, In-App Review on Android) right after a success moment, at most once per version, never on first launch.",
      doneWhen: ["The native review prompt appears after a success moment", "It's shown at most once per app version and never on first launch"],
    },
  },
];

export const loopSourceKey = (id: LoopId) => `loop:${id}`;

/** The checks for one app, joined with any tickets already building them. */
export function auditLoops(repoPath: string, backlog: Backlog): LoopCheck[] {
  const repo = indexRepo(repoPath);
  return LOOPS.map((d) => {
    const t = backlog.tickets.find((x) => x.source.kind === "day2_proposal" && x.source.key === loopSourceKey(d.id));
    if (d.mobileOnly && !repo.isMobile) return { id: d.id, name: d.name, why: d.why, status: "not_applicable" as const, evidence: null, ticket: null };
    const evidence = d.find(repo);
    return {
      id: d.id,
      name: d.name,
      why: d.why,
      status: evidence ? ("present" as const) : ("missing" as const),
      evidence,
      ticket: t ? { id: t.id, state: t.state } : null,
    };
  });
}

/** The backlog ticket for building a missing loop. */
export function loopTicket(id: LoopId): NewTicketInput {
  const d = LOOPS.find((l) => l.id === id);
  if (!d) throw new Error(`Unknown loop ${id}.`);
  return {
    title: d.ticket.title,
    type: d.ticket.type,
    description: `${d.ticket.description}\n\nWhy: ${d.why}`,
    doneWhen: d.ticket.doneWhen,
    priority: 2,
    prioritySource: "day2",
    source: { kind: "day2_proposal", key: loopSourceKey(id) },
    actor: "day2",
    createdNote: "Suggested by day2's growth check: this spreads the app without ad spend.",
  };
}
