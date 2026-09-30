import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUploadedAsset,
  loadDesignReferences,
  parseFigmaFetchResult,
  removeUploadedAsset,
  renderDesignReferencesSummary,
  saveDesignReferences,
  setFigmaFileUrl,
} from "./design-references";
import type { DesignReferences } from "./design-references";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "day2-design-references-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MARKER = "FIGMA_DESIGN_CONTEXT:";

describe("loadDesignReferences", () => {
  test("returns a safe empty default when no file exists", () => {
    withTempDir((dir) => {
      const refs = loadDesignReferences(join(dir, ".day2-design-references.json"));
      expect(refs.uploadedAssets).toEqual([]);
      expect(refs.figmaFileUrl).toBeUndefined();
    });
  });

  test("round-trips a saved config", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-design-references.json");
      const refs: DesignReferences = {
        uploadedAssets: [{ filename: "logo.png", description: "Primary logo", uploadedAt: "2026-09-30T00:00:00.000Z" }],
        figmaFileUrl: "https://figma.com/file/abc123",
        figmaConnectedAt: "2026-09-30T00:00:00.000Z",
      };
      saveDesignReferences(path, refs);
      expect(loadDesignReferences(path)).toEqual(refs);
    });
  });

  test("throws on invalid JSON", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-design-references.json");
      writeFileSync(path, "{ not valid json");
      expect(() => loadDesignReferences(path)).toThrow();
    });
  });

  test("throws on a structurally invalid file (uploadedAssets not an array)", () => {
    withTempDir((dir) => {
      const path = join(dir, ".day2-design-references.json");
      writeFileSync(path, JSON.stringify({ uploadedAssets: "not-an-array" }));
      expect(() => loadDesignReferences(path)).toThrow();
    });
  });
});

describe("addUploadedAsset / removeUploadedAsset", () => {
  test("copies the real file into .day2-brand-assets/, records it, and a re-upload overwrites both", () => {
    withTempDir((dir) => {
      const manifestPath = join(dir, ".day2-design-references.json");
      const sourceFile = join(dir, "logo.png");
      writeFileSync(sourceFile, "v1 bytes");

      let refs = addUploadedAsset(manifestPath, { uploadedAssets: [] }, sourceFile, "Primary logo", "2026-09-30T00:00:00.000Z");
      expect(refs.uploadedAssets).toHaveLength(1);
      expect(refs.uploadedAssets[0]!.filename).toBe("logo.png");
      expect(existsSync(join(dir, ".day2-brand-assets", "logo.png"))).toBe(true);
      expect(readFileSync(join(dir, ".day2-brand-assets", "logo.png"), "utf-8")).toBe("v1 bytes");

      writeFileSync(sourceFile, "v2 bytes");
      refs = addUploadedAsset(manifestPath, refs, sourceFile, "Updated logo", "2026-10-01T00:00:00.000Z");
      expect(refs.uploadedAssets).toHaveLength(1);
      expect(refs.uploadedAssets[0]!.description).toBe("Updated logo");
      expect(readFileSync(join(dir, ".day2-brand-assets", "logo.png"), "utf-8")).toBe("v2 bytes");
    });
  });

  test("removeUploadedAsset drops the manifest entry but never deletes the real file", () => {
    withTempDir((dir) => {
      const manifestPath = join(dir, ".day2-design-references.json");
      const sourceFile = join(dir, "logo.png");
      writeFileSync(sourceFile, "bytes");

      let refs = addUploadedAsset(manifestPath, { uploadedAssets: [] }, sourceFile, "Logo", "2026-09-30T00:00:00.000Z");
      refs = removeUploadedAsset(refs, "logo.png");
      expect(refs.uploadedAssets).toEqual([]);
      expect(existsSync(join(dir, ".day2-brand-assets", "logo.png"))).toBe(true);
    });
  });
});

describe("setFigmaFileUrl", () => {
  test("sets a figma file url and timestamp", () => {
    const refs = setFigmaFileUrl({ uploadedAssets: [] }, "https://figma.com/file/xyz", "2026-09-30T00:00:00.000Z");
    expect(refs.figmaFileUrl).toBe("https://figma.com/file/xyz");
    expect(refs.figmaConnectedAt).toBe("2026-09-30T00:00:00.000Z");
  });

  test("clears the figma file url when passed undefined", () => {
    const withFigma: DesignReferences = {
      uploadedAssets: [],
      figmaFileUrl: "https://figma.com/file/xyz",
      figmaConnectedAt: "2026-09-30T00:00:00.000Z",
    };
    const cleared = setFigmaFileUrl(withFigma, undefined, "2026-10-01T00:00:00.000Z");
    expect(cleared.figmaFileUrl).toBeUndefined();
    expect(cleared.figmaConnectedAt).toBeUndefined();
  });
});

describe("renderDesignReferencesSummary", () => {
  test("reports zero assets and no figma connection for the empty default", () => {
    const summary = renderDesignReferencesSummary({ uploadedAssets: [] });
    expect(summary).toContain("Uploaded assets: 0");
    expect(summary).toContain("not connected");
  });

  test("reports uploaded assets and a connected figma file", () => {
    const summary = renderDesignReferencesSummary({
      uploadedAssets: [{ filename: "logo.png", description: "Primary logo", uploadedAt: "2026-09-30T00:00:00.000Z" }],
      figmaFileUrl: "https://figma.com/file/abc",
      figmaConnectedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(summary).toContain("logo.png");
    expect(summary).toContain("https://figma.com/file/abc");
  });
});

describe("parseFigmaFetchResult", () => {
  test("parses a well-formed fetched result", () => {
    const text = `${MARKER}\n${JSON.stringify({ status: "fetched", summary: "Real teal/navy palette, Inter typeface, 3 key screens." })}`;
    const result = parseFigmaFetchResult(text, "https://figma.com/file/abc", 0.02);
    expect(result.status).toBe("fetched");
    if (result.status === "fetched") {
      expect(result.context.summary).toContain("Inter typeface");
      expect(result.context.figmaFileUrl).toBe("https://figma.com/file/abc");
      expect(result.costUsd).toBe(0.02);
    }
  });

  test("parses an honest fetch_failed result", () => {
    const text = `${MARKER}\n${JSON.stringify({ status: "fetch_failed", reason: "tool did not respond" })}`;
    const result = parseFigmaFetchResult(text, "https://figma.com/file/abc", 0);
    expect(result).toEqual({ status: "fetch_failed", reason: "tool did not respond" });
  });

  test("fails closed to fetch_failed when the marker is missing", () => {
    const result = parseFigmaFetchResult("no marker here", "https://figma.com/file/abc", 0);
    expect(result.status).toBe("fetch_failed");
  });

  test("fails closed to fetch_failed on malformed JSON", () => {
    const result = parseFigmaFetchResult(`${MARKER}\nnot json {{{`, "https://figma.com/file/abc", 0);
    expect(result.status).toBe("fetch_failed");
  });

  test("fails closed to fetch_failed when summary is empty", () => {
    const text = `${MARKER}\n${JSON.stringify({ status: "fetched", summary: "" })}`;
    const result = parseFigmaFetchResult(text, "https://figma.com/file/abc", 0);
    expect(result.status).toBe("fetch_failed");
  });
});
