/**
 * Day2's generic interaction-friction detector — canonical source, meant to
 * be installed verbatim into every rolled-out app's client bundle, the same
 * way `day2-config.ts`/`day2-events.ts` were for expense-buddy. Framework-
 * agnostic (plain DOM APIs only) and zero app-specific knowledge: no
 * references to any particular form, field, or component. An app installs
 * this by copying the file and calling `observeInteractionFriction()` once
 * at startup with its own event-recording callback — the mechanical
 * two-line integration every future app should repeat, not a bespoke
 * reimplementation per app.
 *
 * Detects the PostHog-equivalent of a "rage click": repeated clicks on the
 * same interactive element within a short window where nothing visibly
 * changed nearby — a genuine, generic frustration signal (the user tried
 * the same thing more than once because the first attempt appeared to do
 * nothing), not a heuristic tied to any one app's validation logic.
 */

export type FrictionSignal = {
  /** A stable-enough identifier for "the same element" across repeated
   * clicks: prefers a real `data-testid`/`id`, falls back to a generated
   * description (tag + accessible name + DOM path) for apps that don't tag
   * their markup — degrades gracefully rather than refusing to detect
   * anything. */
  target: string;
  /** How many rapid clicks were observed before this signal fired. */
  clickCount: number;
  /** The page path at the time of the clicks, so a scout can tell which
   * screen/flow is affected without needing a full session replay. */
  path: string;
};

export type InteractionTelemetryOptions = {
  onSignal: (signal: FrictionSignal) => void;
  /** Clicks on the same target within this window count toward one streak. */
  windowMs?: number;
  /** Streak length that counts as "rage", not an accidental double-click. */
  clickThreshold?: number;
  /** How long after the last click to wait before deciding nothing visibly
   * changed. Real UI updates (even an async fetch-driven one) normally
   * land well inside this window; a genuinely stuck/broken control won't. */
  mutationGraceMs?: number;
};

const DEFAULTS = { windowMs: 2500, clickThreshold: 3, mutationGraceMs: 600 } as const;

/** Best-effort stable identity for an element, generic across any app's
 * markup. `data-testid`/`id` win when present (an app can opt into more
 * precise grouping for free by adding either); otherwise falls back to a
 * tag + accessible-name description, which is coarser but still generically
 * derivable from any DOM, matching this module's "works with zero app-
 * specific setup" design goal. */
function describeTarget(el: Element): string {
  const testId = el.getAttribute("data-testid");
  if (testId) return `testid:${testId}`;
  if (el.id) return `id:${el.id}`;
  const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "";
  return `${el.tagName.toLowerCase()}:${name}`;
}

/** Walks up from the click target to the nearest real interactive element
 * (button/link/input/anything with a click handler's usual role) — a click
 * on an icon *inside* a button should count as a click on the button, the
 * same way a real user experiences it. */
function nearestInteractive(el: Element | null): Element | null {
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "button" || tag === "a" || tag === "input" || tag === "select" || cur.getAttribute("role") === "button") {
      return cur;
    }
    cur = cur.parentElement;
  }
  return el;
}

/**
 * Attaches one delegated click listener for the page's lifetime. Pure DOM
 * APIs only (no framework dependency) so this works identically whether the
 * host app is React, Vue, or anything else — matches this module's purpose
 * as a drop-in for any future day2-managed app, not just today's React one.
 */
export function observeInteractionFriction(options: InteractionTelemetryOptions): () => void {
  const { onSignal, windowMs, clickThreshold, mutationGraceMs } = { ...DEFAULTS, ...options };
  const streaks = new Map<string, { count: number; firstAt: number; mutated: boolean }>();
  const observer = new MutationObserver(() => {
    // Any DOM mutation during the grace window counts as "something visibly
    // responded" — generic and conservative (a few false "it worked" reads
    // on a page with unrelated animation are far less costly than false
    // "it's broken" reports), not scoped to any one app's component tree.
    for (const streak of streaks.values()) streak.mutated = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });

  function onClick(e: MouseEvent) {
    const target = nearestInteractive(e.target as Element | null);
    if (!target) return;
    const key = describeTarget(target);
    const now = Date.now();
    const existing = streaks.get(key);

    if (!existing || now - existing.firstAt > windowMs) {
      streaks.set(key, { count: 1, firstAt: now, mutated: false });
    } else {
      existing.count += 1;
    }

    const streak = streaks.get(key)!;
    if (streak.count >= clickThreshold) {
      const path = typeof location !== "undefined" ? location.pathname : "";
      setTimeout(() => {
        if (!streak.mutated) {
          onSignal({ target: key, clickCount: streak.count, path });
        }
        streaks.delete(key); // one signal per streak, not one per subsequent click
      }, mutationGraceMs);
    }
  }

  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("click", onClick, true);
    observer.disconnect();
  };
}
