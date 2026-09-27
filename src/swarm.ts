import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Swarm v1 (COORDINATION.md W13, Step 1 roadmap): "persona/adversarial/
 * accessibility agents that pre-test changes before release," per the
 * source doc — a different mechanism from STAGE0.md's "swarm" (Sentry
 * production monitoring, which detects problems *after* real users hit
 * them). This one tests a change *before* any real user does, against the
 * canary's own isolated preview URL (release.ts already proved this exists
 * and carries zero production traffic on its own).
 *
 * Each persona is a real Claude Agent SDK session with real browser
 * automation (Playwright), not a content-only page fetch — it actually
 * clicks, types, and navigates the deployed app, because a smoke check
 * (`fetch(previewUrl)` returning 200) can't catch a confusing flow, a
 * keyboard trap, or a form that silently drops input.
 */

const MODEL = process.env.DAY2_MODEL ?? "claude-sonnet-5";
// 20 wasn't always enough — a real mobile-viewport run (device emulation +
// multi-step interaction) hit the cap before reaching a verdict. Budget is
// the real safety rail regardless.
const MAX_TURNS = 30;
const MAX_BUDGET_USD = 1;

const orchestratorRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_NODE_MODULES = join(orchestratorRoot, "node_modules");

/** Same denylist as agent.ts's fix/verifier agents — the orchestrator's own
 * secrets have no reason to be visible to a sandboxed shell testing an
 * unrelated deployed web page. */
const DENIED_ENV_VARS = ["SENTRY_AUTH_TOKEN", "SENTRY_REGION_URL", "ANTHROPIC_API_KEY"];
const home = homedir();
const DENIED_READ_PATHS = [
  `${home}/.ssh`,
  `${home}/.aws`,
  `${home}/.claude`,
  `${home}/.config/gh`,
  `${home}/.netrc`,
  `${home}/.npmrc`,
  `${home}/.docker`,
  `${home}/.gnupg`,
];

/** Playwright's built-in device profiles set viewport, user agent, and touch
 * support together — one line, not a hand-maintained pixel size. "iPhone
 * 14" is a representative, currently-shipping small-viewport phone; a wider
 * device matrix (tablets, small Android) is a reasonable v2, not attempted
 * here (see the "not built" note in STAGE1.md's W13 entry). */
export type Viewport = "desktop" | "mobile";

const VIEWPORT_INSTRUCTIONS: Record<Viewport, string> = {
  desktop: `Use a standard desktop browser context — \`chromium.launch()\` then
\`browser.newContext()\` with no device emulation (Playwright's default
viewport). Interact with the mouse and keyboard as normal.`,
  mobile: `Emulate a phone using Playwright's built-in device profile:
\`import { chromium, devices } from "playwright"\`, then
\`browser.newContext({ ...devices["iPhone 14"] })\`. This sets the real
mobile viewport, user agent, and touch support together. Use taps (Playwright's
\`.tap()\`, which these mobile contexts support since \`hasTouch\` is on), not
mouse clicks, for anything a phone user would touch — and pay specific
attention to whether content is cut off, overlapping, or requires horizontal
scrolling at this width, since that's the class of bug a desktop-only check
can't see at all.`,
};

/** A persona is a role (what to test for) crossed with a viewport (what
 * screen it's tested at) — every base persona below runs once per viewport
 * in `DEFAULT_PERSONAS`, since accessibility, adversarial-input, and
 * novice-user issues can all differ — or appear *only* — at a phone width. */
export type Persona = { name: string; task: string; viewport: Viewport };
type BasePersona = { name: string; task: string };

/** v1: one novice-user pass, one accessibility pass, one adversarial-input
 * pass — the three categories the source doc names explicitly. Each is
 * deliberately scoped to expense-buddy's real, current UI (a single-page
 * add/list expense tracker) rather than written generically, since a vague
 * persona produces a vague (and expensive) agent run. */
const BASE_PERSONAS: BasePersona[] = [
  {
    name: "novice-user",
    task: `You are a first-time user who has never seen this app before. Add
two new expenses with different categories, confirm the "Spent this month"
total updated correctly to include them, then delete one of the two you
just added. Report anything confusing, broken, unresponsive, or that
doesn't behave the way a reasonable first-time user would expect.`,
  },
  {
    name: "accessibility-auditor",
    task: `You are auditing this page for accessibility. Using only the
keyboard (Tab/Shift+Tab/Enter/Space — no mouse), try to: reach the amount
field, note field, category selector, and date field of the "Add an
expense" form, submit it, and reach the delete control on an existing
expense row. Check whether each interactive element has a visible focus
indicator and a programmatically associated label. Report concrete
violations you actually encountered while doing this, not a general
checklist.

Two things that will make you misreport a working element as broken if you
skip them (both hit real false positives in earlier runs, so check for
real, don't skip):
- If an element's focus style is CSS-transitioned (opacity, outline, etc.
  animating in rather than appearing instantly), reading its computed style
  immediately after focusing can catch it mid-transition. Wait a few
  hundred milliseconds after focusing before you read/screenshot it, so you
  see its settled state, not a snapshot mid-animation.
- \`document.activeElement\` reports the shadow *host* element, not the
  actual focused node, when focus lands inside an open shadow root (e.g. a
  third-party widget). Before judging an element's visibility or label from
  \`document.activeElement\`, check whether it has a \`shadowRoot\` and, if
  so, drill into \`el.shadowRoot.activeElement\` (repeat if nested) to find
  the real focused element first.`,
  },
  {
    name: "adversarial-input",
    task: `You are trying to break the "Add an expense" form with unusual
input. Separately try: a negative amount, an extremely large amount
(e.g. 999999999), a note over 500 characters long, and a note containing
"<script>alert(1)</script>". For each, report what actually happened —
rejected gracefully, crashed, silently did something wrong, or rendered
the input unescaped back onto the page.`,
  },
];

const VIEWPORTS: Viewport[] = ["desktop", "mobile"];

export const DEFAULT_PERSONAS: Persona[] = BASE_PERSONAS.flatMap((base) =>
  VIEWPORTS.map((viewport) => ({
    name: `${base.name}-${viewport}`,
    task: base.task,
    viewport,
  })),
);

export type PersonaResult = {
  persona: string;
  passed: boolean;
  summary: string;
  isError: boolean;
  costUsd: number;
};

function buildPrompt(previewUrl: string, persona: Persona): string {
  return `You are testing a deployed web app as part of an automated pre-release
check ("swarm v1"). The app is live at exactly this URL — never guess or
construct a different one:

${previewUrl}

Your persona: ${persona.name}

${persona.task}

Screen size for this run: ${VIEWPORT_INSTRUCTIONS[persona.viewport]}

Playwright is already installed in this directory — \`import { chromium } from "playwright"\`
works without any install step. Write a small script (e.g. check.mjs) that
launches a real browser, navigates to the URL above, and actually performs
the steps described — click/tap, type, use the keyboard — rather than only
reading the page's raw HTML. Run it with \`node check.mjs\`. This URL
carries no real production traffic (it's an isolated preview version), so
interacting with it freely is safe and expected.

When finished, end your final message with exactly one line: either
"SWARM_VERDICT: PASS" (no real problem found) or
"SWARM_VERDICT: FAIL — <concise, specific reason>" (a real, concrete problem).

If you're running low on turns, stop investigating further and end with
your best current verdict right away, based on what you've already found —
a short, concrete one, not a longer report. A run that never reaches a
parseable verdict line fails closed regardless, so an unfinished long
report gets you nothing a timely short one wouldn't.`;
}

async function runPersona(previewUrl: string, persona: Persona): Promise<PersonaResult> {
  const cwd = mkdtempSync(join(tmpdir(), "day2-swarm-"));
  symlinkSync(SHARED_NODE_MODULES, join(cwd, "node_modules"));

  let finalText = "";
  let isError = false;
  let costUsd = 0;

  try {
    // The SDK doesn't always deliver "ran out of turns/budget" as a `result`
    // message with `is_error: true` — found live (a real mobile-viewport run
    // hit `maxTurns` and instead *threw*, which uncaught would reject this
    // persona's promise and, via `Promise.all` in runSwarm, take every other
    // in-flight persona down with it. One persona failing to finish must
    // fail closed on its own, not sink the whole batch.
    try {
      for await (const message of query({
        prompt: buildPrompt(previewUrl, persona),
        options: {
          cwd,
          model: MODEL,
          permissionMode: "bypassPermissions",
          maxTurns: MAX_TURNS,
          maxBudgetUsd: MAX_BUDGET_USD,
          persistSession: false,
          settingSources: [],
          settings: { disableClaudeAiConnectors: true },
          tools: ["Bash", "Read", "Write", "Edit"],
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            failIfUnavailable: true,
            credentials: {
              envVars: DENIED_ENV_VARS.map((name) => ({ name, mode: "deny" as const })),
            },
            filesystem: { denyRead: DENIED_READ_PATHS },
          },
        },
      })) {
        if (message.type === "result") {
          finalText = message.result ?? "";
          isError = Boolean(message.is_error);
          costUsd = message.total_cost_usd ?? 0;
        }
      }
    } catch (err) {
      isError = true;
      finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  return { persona: persona.name, ...parseVerdict(finalText, isError), isError, costUsd };
}

/** Pure and separately tested: an agent transcript ending abruptly, hitting
 * its turn/budget cap, or an unparseable final message must fail closed
 * (`passed: false`) rather than default to a pass just because no explicit
 * "FAIL" substring was seen — the persona failing to *reach* a verdict is
 * itself not a clean bill of health. */
export function parseVerdict(
  finalText: string,
  isError: boolean,
): { passed: boolean; summary: string } {
  const verdictLine =
    finalText
      .split("\n")
      .find((l) => l.trim().startsWith("SWARM_VERDICT:"))
      ?.trim() ?? "";
  const passed = !isError && verdictLine.includes("PASS") && !verdictLine.includes("FAIL");
  return { passed, summary: verdictLine || finalText.slice(0, 500).trim() || "(no output)" };
}

export async function runSwarm(
  previewUrl: string,
  personas: Persona[] = DEFAULT_PERSONAS,
): Promise<{ allPassed: boolean; results: PersonaResult[] }> {
  const results = await Promise.all(personas.map((p) => runPersona(previewUrl, p)));
  return { allPassed: results.every((r) => r.passed), results };
}

/**
 * Comparison-test mode (COORDINATION.md W16): not a pre-release gate like
 * `runSwarm` above — this runs the *same* task for a persona under a
 * specific, pre-seeded device ID, so the same scenario can be run once
 * against the real default config and once against a real, different
 * config, and the two outcomes compared. This is synthetic evidence toward
 * the still-blocked real-user retention-lift question, not a replacement
 * for it — see docs/w16-swarm-comparison-results.md for the honest framing.
 *
 * Deliberately not reusing `Persona`'s viewport-crossing shape: this needs
 * one fixed condition (a specific device ID) per run, not a persona×viewport
 * matrix. Shares `runPersona`'s SDK invocation pattern (same model/turn/
 * budget/sandbox setup) rather than the prompt template, since the prompt
 * itself is structurally different (task-completion + friction/action-count
 * reporting, not a pass/fail audit verdict).
 */
export type ComparisonResult = {
  condition: string;
  deviceId: string;
  completed: boolean;
  actionCount: number | null;
  friction: string;
  isError: boolean;
  costUsd: number;
};

function buildComparisonPrompt(previewUrl: string, deviceId: string, task: string): string {
  return `You are testing a deployed web app as part of a controlled comparison
test. The app is live at exactly this URL — never guess or construct a
different one:

${previewUrl}

**Critical setup step, do this before navigating anywhere:** this test
needs your browser session to be identified as a specific existing device,
not a fresh one. Before your first \`page.goto()\`, call
\`page.addInitScript(() => { localStorage.setItem("day2-device-id", "${deviceId}"); })\`
on the page/context. This must run via \`addInitScript\`, not a
\`page.evaluate()\` after the page loads — the app reads this value from
\`localStorage\` in its own startup code, immediately on mount, so setting
it any later means the app already started up before your value existed.

Your task:

${task}

Playwright is already installed in this directory —
\`import { chromium } from "playwright"\` works without any install step.
Write a small script (e.g. check.mjs) that launches a real browser,
sets up the device ID exactly as described above, navigates to the URL,
and actually performs the task — click, type, use the keyboard — rather
than only reading the page's raw HTML. Run it with \`node check.mjs\`.
This is a real, live app but the actions in this task (adding and deleting
a handful of test expense entries) are safe, expected, and exactly what
this test is for.

While doing the task, count every distinct UI action you take (each click,
each tap, each field you type into, each key you press) — you'll report
this count.

Also note anything that caused you confusion, hesitation, or extra steps
you wouldn't have expected to need — be specific about what happened, not
a general impression.

When finished, end your final message with exactly these three lines, in
this exact format (all three required):
COMPARISON_COMPLETED: <true or false — true only if you finished every part of the task>
COMPARISON_ACTIONS: <the integer count of distinct UI actions you took>
COMPARISON_FRICTION: <one or two sentences on what caused friction, confusion, or extra steps — or "none" if genuinely nothing did>`;
}

export function parseComparisonResult(
  finalText: string,
  isError: boolean,
): { completed: boolean; actionCount: number | null; friction: string } {
  const line = (prefix: string) =>
    finalText
      .split("\n")
      .find((l) => l.trim().startsWith(prefix))
      ?.slice(prefix.length)
      .trim();

  const completedRaw = line("COMPARISON_COMPLETED:");
  const actionsRaw = line("COMPARISON_ACTIONS:");
  const frictionRaw = line("COMPARISON_FRICTION:");

  // Same fail-closed discipline as parseVerdict: a transcript that never
  // reached a real, well-formed completion line is not a completed run,
  // regardless of how the rest of the transcript reads.
  const completed = !isError && completedRaw?.toLowerCase() === "true";
  const parsedActions = actionsRaw ? Number.parseInt(actionsRaw, 10) : NaN;
  const actionCount = Number.isFinite(parsedActions) ? parsedActions : null;
  const friction = frictionRaw || (isError ? "(agent run did not complete)" : "(no friction line reported)");

  return { completed, actionCount, friction };
}

export async function runComparisonPersona(
  previewUrl: string,
  condition: string,
  deviceId: string,
  task: string,
): Promise<ComparisonResult> {
  const cwd = mkdtempSync(join(tmpdir(), "day2-comparison-"));
  symlinkSync(SHARED_NODE_MODULES, join(cwd, "node_modules"));

  let finalText = "";
  let isError = false;
  let costUsd = 0;

  try {
    try {
      for await (const message of query({
        prompt: buildComparisonPrompt(previewUrl, deviceId, task),
        options: {
          cwd,
          model: MODEL,
          permissionMode: "bypassPermissions",
          maxTurns: MAX_TURNS,
          maxBudgetUsd: MAX_BUDGET_USD,
          persistSession: false,
          settingSources: [],
          settings: { disableClaudeAiConnectors: true },
          tools: ["Bash", "Read", "Write", "Edit"],
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
            failIfUnavailable: true,
            credentials: {
              envVars: DENIED_ENV_VARS.map((name) => ({ name, mode: "deny" as const })),
            },
            filesystem: { denyRead: DENIED_READ_PATHS },
          },
        },
      })) {
        if (message.type === "result") {
          finalText = message.result ?? "";
          isError = Boolean(message.is_error);
          costUsd = message.total_cost_usd ?? 0;
        }
      }
    } catch (err) {
      isError = true;
      finalText = `(agent run threw before producing a result: ${(err as Error).message})`;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  return { condition, deviceId, ...parseComparisonResult(finalText, isError), isError, costUsd };
}
