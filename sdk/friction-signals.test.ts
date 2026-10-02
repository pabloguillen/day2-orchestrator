import { describe, expect, test } from "bun:test";
import { deriveFrictionSignals, type GenericStoredEvent } from "./friction-signals";

function rageClick(target: string, path: string, at: string): GenericStoredEvent {
  return { type: "rage_click", at, metadata: { target, path, clickCount: 3 } };
}

describe("deriveFrictionSignals", () => {
  test("no rage_click events at all: empty result", () => {
    expect(deriveFrictionSignals({ "device-1": [{ type: "session_start", at: "2026-01-01", metadata: null }] })).toEqual([]);
  });

  test("a single rage_click from one device produces one signal with affectedDevices: 1", () => {
    const result = deriveFrictionSignals({
      "device-1": [rageClick("id:save", "/checkout", "2026-01-01T00:00:00.000Z")],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: "id:save", path: "/checkout", occurrences: 1, affectedDevices: 1 });
  });

  test("the same target+path from multiple devices aggregates into one signal with the right affectedDevices", () => {
    const result = deriveFrictionSignals({
      "device-1": [rageClick("id:save", "/checkout", "2026-01-01T00:00:00.000Z")],
      "device-2": [rageClick("id:save", "/checkout", "2026-01-02T00:00:00.000Z")],
      "device-3": [rageClick("id:save", "/checkout", "2026-01-03T00:00:00.000Z")],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.occurrences).toBe(3);
    expect(result[0]!.affectedDevices).toBe(3);
    expect(result[0]!.firstSeen).toBe("2026-01-01T00:00:00.000Z");
    expect(result[0]!.lastSeen).toBe("2026-01-03T00:00:00.000Z");
  });

  test("multiple occurrences from the SAME device count toward occurrences but not affectedDevices twice", () => {
    const result = deriveFrictionSignals({
      "device-1": [
        rageClick("id:save", "/checkout", "2026-01-01T00:00:00.000Z"),
        rageClick("id:save", "/checkout", "2026-01-02T00:00:00.000Z"),
      ],
    });
    expect(result[0]!.occurrences).toBe(2);
    expect(result[0]!.affectedDevices).toBe(1);
  });

  test("different targets or different paths produce separate signals", () => {
    const result = deriveFrictionSignals({
      "device-1": [
        rageClick("id:save", "/checkout", "2026-01-01T00:00:00.000Z"),
        rageClick("id:cancel", "/checkout", "2026-01-01T00:00:00.000Z"),
        rageClick("id:save", "/settings", "2026-01-01T00:00:00.000Z"),
      ],
    });
    expect(result).toHaveLength(3);
  });

  test("non-rage_click events are ignored even if they have similar-looking metadata", () => {
    const result = deriveFrictionSignals({
      "device-1": [{ type: "expense_added", at: "2026-01-01T00:00:00.000Z", metadata: { target: "id:save", path: "/x" } }],
    });
    expect(result).toEqual([]);
  });

  test("malformed rage_click metadata (missing target/path, wrong types, null) is skipped, not thrown", () => {
    const events: GenericStoredEvent[] = [
      { type: "rage_click", at: "2026-01-01T00:00:00.000Z", metadata: null },
      { type: "rage_click", at: "2026-01-01T00:00:00.000Z", metadata: "not-an-object" },
      { type: "rage_click", at: "2026-01-01T00:00:00.000Z", metadata: { target: "id:save" } }, // missing path
      { type: "rage_click", at: "2026-01-01T00:00:00.000Z", metadata: { target: 42, path: "/x" } }, // wrong type
    ];
    expect(() => deriveFrictionSignals({ "device-1": events })).not.toThrow();
    expect(deriveFrictionSignals({ "device-1": events })).toEqual([]);
  });

  test("empty device map produces no signals", () => {
    expect(deriveFrictionSignals({})).toEqual([]);
  });
});
