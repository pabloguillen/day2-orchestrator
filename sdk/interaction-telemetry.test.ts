import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

/**
 * Real-browser tests, not a DOM mock — `interaction-telemetry.ts` is pure
 * DOM API usage (MutationObserver, click delegation), the exact class of
 * logic this project has learned (W15's focus-ring gap, the two swarm false
 * positives) not to trust a simulated environment for. Bun's own
 * transpiler strips the TS types so the real module can be injected as
 * plain JS into a real page — no new build tooling needed for this.
 */

let browser: Browser;
let page: Page;
let moduleJs: string;

beforeAll(async () => {
  const source = await Bun.file(new URL("./interaction-telemetry.ts", import.meta.url)).text();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  // Strip the ES module export so the script attaches to `window` instead —
  // a plain `page.addScriptTag` runs as a classic script, not a module.
  moduleJs = transpiler
    .transformSync(source)
    .replace("export function observeInteractionFriction", "window.observeInteractionFriction = function");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

async function freshPage(html: string): Promise<Page> {
  const p = await browser.newPage();
  await p.setContent(html);
  await p.addScriptTag({ content: moduleJs });
  return p;
}

describe("observeInteractionFriction", () => {
  test("fires a signal after N rapid clicks on the same button produce no DOM change", async () => {
    page = await freshPage(`<button id="save">Save</button>`);
    const signals = await page.evaluate(() => {
      const found: unknown[] = [];
      // @ts-expect-error injected global, not a real import in this page context
      window.observeInteractionFriction({ onSignal: (s: unknown) => found.push(s) });
      const btn = document.getElementById("save")!;
      btn.click();
      btn.click();
      btn.click();
      return new Promise((resolve) => setTimeout(() => resolve(found), 800));
    });
    expect(signals).toHaveLength(1);
    expect((signals[0] as { target: string }).target).toBe("id:save");
    expect((signals[0] as { clickCount: number }).clickCount).toBe(3);
    await page.close();
  });

  test("does NOT fire when the DOM actually changes in response to a click", async () => {
    page = await freshPage(`
      <button id="add" onclick="document.getElementById('list').appendChild(document.createElement('li'))">Add</button>
      <ul id="list"></ul>
    `);
    const signals = await page.evaluate(() => {
      const found: unknown[] = [];
      // @ts-expect-error injected global
      window.observeInteractionFriction({ onSignal: (s: unknown) => found.push(s) });
      const btn = document.getElementById("add")!;
      btn.click();
      btn.click();
      btn.click();
      return new Promise((resolve) => setTimeout(() => resolve(found), 800));
    });
    expect(signals).toHaveLength(0);
    await page.close();
  });

  test("does NOT fire for fewer clicks than the threshold", async () => {
    page = await freshPage(`<button id="save">Save</button>`);
    const signals = await page.evaluate(() => {
      const found: unknown[] = [];
      // @ts-expect-error injected global
      window.observeInteractionFriction({ onSignal: (s: unknown) => found.push(s) });
      document.getElementById("save")!.click();
      document.getElementById("save")!.click();
      return new Promise((resolve) => setTimeout(() => resolve(found), 800));
    });
    expect(signals).toHaveLength(0);
    await page.close();
  });

  test("a click on an icon inside a button counts as a click on the button", async () => {
    page = await freshPage(`<button id="save"><span id="icon">X</span>Save</button>`);
    const signals = await page.evaluate(() => {
      const found: unknown[] = [];
      // @ts-expect-error injected global
      window.observeInteractionFriction({ onSignal: (s: unknown) => found.push(s) });
      const icon = document.getElementById("icon")!;
      icon.click();
      icon.click();
      icon.click();
      return new Promise((resolve) => setTimeout(() => resolve(found), 800));
    });
    expect(signals).toHaveLength(1);
    expect((signals[0] as { target: string }).target).toBe("id:save");
    await page.close();
  });

  test("two different elements each clicked below threshold do not combine into one streak", async () => {
    page = await freshPage(`<button id="a">A</button><button id="b">B</button>`);
    const signals = await page.evaluate(() => {
      const found: unknown[] = [];
      // @ts-expect-error injected global
      window.observeInteractionFriction({ onSignal: (s: unknown) => found.push(s) });
      document.getElementById("a")!.click();
      document.getElementById("b")!.click();
      document.getElementById("a")!.click();
      document.getElementById("b")!.click();
      return new Promise((resolve) => setTimeout(() => resolve(found), 800));
    });
    expect(signals).toHaveLength(0);
    await page.close();
  });

  test("falls back to a tag+accessible-name description when no id/data-testid exists", async () => {
    page = await freshPage(`<button aria-label="Record expense">Record expense</button>`);
    const signals = await page.evaluate(() => {
      const found: unknown[] = [];
      // @ts-expect-error injected global
      window.observeInteractionFriction({ onSignal: (s: unknown) => found.push(s) });
      const btn = document.querySelector("button")!;
      btn.click();
      btn.click();
      btn.click();
      return new Promise((resolve) => setTimeout(() => resolve(found), 800));
    });
    expect(signals).toHaveLength(1);
    expect((signals[0] as { target: string }).target).toBe("button:Record expense");
    await page.close();
  });

  test("the returned disconnect function stops further detection", async () => {
    page = await freshPage(`<button id="save">Save</button>`);
    const signals = await page.evaluate(() => {
      const found: unknown[] = [];
      // @ts-expect-error injected global
      const stop = window.observeInteractionFriction({ onSignal: (s: unknown) => found.push(s) });
      stop();
      const btn = document.getElementById("save")!;
      btn.click();
      btn.click();
      btn.click();
      return new Promise((resolve) => setTimeout(() => resolve(found), 800));
    });
    expect(signals).toHaveLength(0);
    await page.close();
  });
});
