import { describe, expect, test } from "bun:test";
import { GENERIC_CONTENT_PATTERNS, buildAuthenticityChecklist } from "./ai-slop-patterns";

describe("GENERIC_CONTENT_PATTERNS", () => {
  test("every pattern has a non-empty id, description, and at least one example", () => {
    expect(GENERIC_CONTENT_PATTERNS.length).toBeGreaterThan(0);
    for (const p of GENERIC_CONTENT_PATTERNS) {
      expect(p.id.trim().length).toBeGreaterThan(0);
      expect(p.description.trim().length).toBeGreaterThan(0);
      expect(p.examples.length).toBeGreaterThan(0);
      for (const example of p.examples) {
        expect(example.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("every pattern id is unique", () => {
    const ids = GENERIC_CONTENT_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildAuthenticityChecklist", () => {
  test("includes every pattern's bracketed id", () => {
    const checklist = buildAuthenticityChecklist();
    for (const p of GENERIC_CONTENT_PATTERNS) {
      expect(checklist).toContain(`[${p.id}]`);
    }
  });

  test("includes every pattern's description and at least its first example", () => {
    const checklist = buildAuthenticityChecklist();
    for (const p of GENERIC_CONTENT_PATTERNS) {
      expect(checklist).toContain(p.description);
      expect(checklist).toContain(p.examples[0]);
    }
  });

  test("is non-empty and doesn't throw with zero patterns hypothetically absent (sanity: real list is non-empty)", () => {
    expect(buildAuthenticityChecklist().length).toBeGreaterThan(0);
  });
});
