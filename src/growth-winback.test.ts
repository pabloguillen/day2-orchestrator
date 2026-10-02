import { describe, expect, test } from "bun:test";
import { parseChurnRiskSegment, renderChurnRiskSegment } from "./growth-winback";

const MARKER = "CHURN_RISK_SEGMENT_JSON:";

describe("parseChurnRiskSegment", () => {
  test("parses a well-formed segment and echoes back the exact deviceIds supplied", () => {
    const text = `${MARKER}\n${JSON.stringify({
      description: "Established users who logged expenses weekly, then stopped for 10+ days.",
      basis: "3 of 4 profiles show sessionCount >= 3 and a 2+ category distribution.",
    })}`;
    const result = parseChurnRiskSegment(text, ["device-1", "device-2"]);
    expect(result).not.toBeNull();
    expect(result!.description).toContain("Established users");
    expect(result!.basis).toContain("sessionCount");
    expect(result!.deviceIds).toEqual(["device-1", "device-2"]);
  });

  test("an honest explicit null is a legitimate result, not a failure", () => {
    expect(parseChurnRiskSegment(`${MARKER}\nnull`, ["d1"])).toBeNull();
  });

  test("no marker fails closed to null", () => {
    expect(parseChurnRiskSegment("no marker here", ["d1"])).toBeNull();
  });

  test("malformed JSON fails closed to null", () => {
    expect(parseChurnRiskSegment(`${MARKER}\nnot json {{{`, ["d1"])).toBeNull();
  });

  test("rejects an object missing basis", () => {
    const text = `${MARKER}\n${JSON.stringify({ description: "x" })}`;
    expect(parseChurnRiskSegment(text, ["d1"])).toBeNull();
  });

  test("rejects an object missing description", () => {
    const text = `${MARKER}\n${JSON.stringify({ basis: "y" })}`;
    expect(parseChurnRiskSegment(text, ["d1"])).toBeNull();
  });

  test("rejects an empty-string description", () => {
    const text = `${MARKER}\n${JSON.stringify({ description: "   ", basis: "y" })}`;
    expect(parseChurnRiskSegment(text, ["d1"])).toBeNull();
  });

  test("empty deviceIds list still parses the segment but echoes an empty list back", () => {
    const text = `${MARKER}\n${JSON.stringify({ description: "d", basis: "b" })}`;
    const result = parseChurnRiskSegment(text, []);
    expect(result!.deviceIds).toEqual([]);
  });
});

describe("renderChurnRiskSegment", () => {
  test("pluralizes device count correctly", () => {
    const rendered = renderChurnRiskSegment({ description: "d", basis: "b", deviceIds: ["only-one"] });
    expect(rendered).toContain("1 device)");
    expect(rendered).not.toContain("1 devices");
  });

  test("renders both the description and the basis", () => {
    const rendered = renderChurnRiskSegment({ description: "real desc", basis: "real basis", deviceIds: ["a", "b"] });
    expect(rendered).toContain("2 devices)");
    expect(rendered).toContain("real desc");
    expect(rendered).toContain("real basis");
  });
});
