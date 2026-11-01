import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMockupPrompt, mockupPath, parseMockupReply, renderMockup } from "./mockups";

describe("mockups before work", () => {
  test("the prompt carries the ticket as data and asks for the app's real look", () => {
    const p = buildMockupPrompt({ title: "City leaderboard", description: "Show the top 10", doneWhen: ["Top 10 visible"], plan: "1. Add a tab" });
    expect(p).toContain('"title":"City leaderboard"');
    expect(p).toContain("NO_UI");
    expect(p).toContain("390×844");
  });

  test("a reply: the note and the HTML, or no UI at all", () => {
    expect(parseMockupReply("NO_UI")).toBe("none");
    expect(parseMockupReply("NOTE: Die neue Bestenliste\n<<<HTML\n<html><body><div>Top 10</div></body></html>\nHTML>>>")).toEqual({ html: "<html><body><div>Top 10</div></body></html>", note: "Die neue Bestenliste" });
    expect(parseMockupReply("sorry")).toBeNull();
  });

  test("only day2's own mockup files are served", () => {
    expect(mockupPath("app_d", "../../etc/passwd")).toBeNull();
    expect(mockupPath("app_d", "D2-1-1.png")).toBeNull(); // not there
  });

  test("rendered to a phone-sized PNG, with web requests blocked", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "day2-mock-")), "m.png");
    try {
      await renderMockup('<html><body style="margin:0;background:#fdf6d8"><img src="https://example.com/x.png"><h1>Top 10</h1></body></html>', out);
    } catch (err) {
      if (/Executable doesn't exist|browserType.launch/.test((err as Error).message)) return; // no browser on this machine
      throw err;
    }
    expect(existsSync(out)).toBe(true);
    const png = readFileSync(out);
    expect(png.readUInt32BE(16)).toBe(780); // 390 × 2
    expect(png.readUInt32BE(20)).toBe(1688); // 844 × 2
  });
});
