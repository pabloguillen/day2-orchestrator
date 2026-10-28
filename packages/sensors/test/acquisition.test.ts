import { describe, expect, test } from "bun:test";
import { acquisitionFrom } from "../src/acquisition";

describe("where a visitor came from", () => {
  test("an ad: experiment, platform, ad — and the platform's click id for conversions", () => {
    expect(acquisitionFrom("https://buddy.example/go/split?d2=B-4.tiktok.v1&ttclid=E.C.P.abc123", "", "buddy.example")).toEqual({ campaignId: "B-4.tiktok.v1", channel: "paid", click: { param: "ttclid", value: "E.C.P.abc123" } });
    expect(acquisitionFrom("https://buddy.example/go?d2=B-4.meta.i1&fbclid=IwAR0xyz", "https://l.facebook.com/", "buddy.example")).toMatchObject({ click: { param: "fbclid", value: "IwAR0xyz" } });
    expect(acquisitionFrom("https://buddy.example/go?d2=B-4.google.t1", "", "buddy.example")).toEqual({ campaignId: "B-4.google.t1", channel: "paid" });
  });
  test("click ids without day2's tag aren't kept", () => {
    expect(acquisitionFrom("https://buddy.example/?gclid=abc", "https://www.google.com/", "buddy.example")).toEqual({ channel: "search" });
  });
});
