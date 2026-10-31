import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { noSleep, scriptedFetch, type Expect, type Recorded } from "../ads/test-helpers";
import { AppStoreError, ascJwt, createAppStore, describeAppleErrors, mapVersionState, trimWhatsNew } from "./app-store";
import type { AscCredential } from "./credentials";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const cred: AscCredential = {
  issuerId: "69a6de7e-1111-47e3-e053-5b8c7c11a4d1",
  keyId: "2X9R4HXF34",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const NOW = new Date("2026-10-31T10:00:00Z");
const B = "https://api.appstoreconnect.apple.com";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
const bearer = (r: Recorded) => {
  expect(r.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
};
const call = (method: string, url: string, json?: unknown, extra: Partial<Expect> = {}): Expect => ({ method, url, json, check: bearer, ...extra });
const body = (method: string, url: string, sent: unknown, json?: unknown, extra: Partial<Expect> = {}): Expect => ({
  method,
  url,
  json,
  check: (r) => {
    bearer(r);
    expect(r.json).toEqual(sent);
  },
  ...extra,
});
const exact = (s: Expect, url: string) => ({ ...s, url: new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });

function store(script: Expect[], now = () => NOW) {
  const f = scriptedFetch(script);
  return { s: createAppStore(cred, { fetch: f.fetch, now, sleep: noSleep }), f };
}

describe("ascJwt", () => {
  test("header, claims and a signature that verifies with the public key", () => {
    const jwt = ascJwt(cred, NOW);
    const [h, c, sig] = jwt.split(".") as [string, string, string];
    expect(decode(h)).toEqual({ alg: "ES256", kid: "2X9R4HXF34", typ: "JWT" });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(decode(c)).toEqual({ iss: cred.issuerId, iat, exp: iat + 1140, aud: "appstoreconnect-v1" });
    const raw = Buffer.from(sig, "base64url");
    expect(raw.length).toBe(64); // r||s, not DER
    const v = createVerify("SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(true);
  });

  test("accepts a key pasted with literal \\n", () => {
    const flat = { ...cred, privateKey: cred.privateKey.replace(/\n/g, "\\n") };
    const [h, c, sig] = ascJwt(flat, NOW).split(".") as [string, string, string];
    const v = createVerify("SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
  });

  test("token reused until a minute before it expires", async () => {
    let t = NOW.getTime();
    const auths: string[] = [];
    const keep = (r: Recorded) => auths.push(r.headers.authorization ?? "");
    const v = (n: number): Expect => ({ method: "GET", url: `/v1/appStoreVersions/v${n}?`, check: keep, json: { data: { type: "appStoreVersions", id: `v${n}`, attributes: { appVersionState: "IN_REVIEW" } } } });
    const { s } = store([v(1), v(2), v(3)], () => new Date(t));
    await s.versionState("v1");
    t += 17 * 60_000;
    await s.versionState("v2");
    t += 2 * 60_000; // 19 min: inside the last minute
    await s.versionState("v3");
    expect(auths[0]).toBe(auths[1]!);
    expect(auths[2]).not.toBe(auths[1]!);
  });
});

describe("findBuild", () => {
  const appsCall = exact(call("GET", "", { data: [{ type: "apps", id: "app1" }] }), `${B}/v1/apps?filter[bundleId]=com.buddy.app&limit=1`);
  const buildsUrl = `${B}/v1/builds?filter[app]=app1&filter[version]=42&filter[preReleaseVersion.version]=1.4.0&sort=-uploadedDate&limit=1`;
  const builds = (data: unknown[]) => exact(call("GET", "", { data }), buildsUrl);
  const q = { bundleId: "com.buddy.app", version: "1.4.0", buildNumber: "42" };

  test("none yet → null; app id cached per bundle id", async () => {
    const { s, f } = store([
      appsCall,
      builds([]),
      builds([{ type: "builds", id: "b1", attributes: { processingState: "PROCESSING", usesNonExemptEncryption: null } }]),
    ]);
    expect(await s.findBuild(q)).toBeNull();
    expect(await s.findBuild(q)).toEqual({ appId: "app1", buildId: "b1", processing: "processing", missingCompliance: true });
    expect(f.done()).toBe(true);
  });

  test("valid with compliance; failed", async () => {
    const { s } = store([
      appsCall,
      builds([{ type: "builds", id: "b1", attributes: { processingState: "VALID", usesNonExemptEncryption: false } }]),
      builds([{ type: "builds", id: "b2", attributes: { processingState: "INVALID" } }]),
    ]);
    expect(await s.findBuild(q)).toEqual({ appId: "app1", buildId: "b1", processing: "valid", missingCompliance: false });
    expect(await s.findBuild(q)).toEqual({ appId: "app1", buildId: "b2", processing: "failed", missingCompliance: true });
  });

  test("no app record → clear error", async () => {
    const { s } = store([call("GET", "/v1/apps?", { data: [] })]);
    await expect(s.findBuild(q)).rejects.toThrow("There's no app with bundle id com.buddy.app in App Store Connect");
  });

  test("setNoNonExemptEncryption", async () => {
    const { s, f } = store([body("PATCH", `${B}/v1/builds/b1`, { data: { type: "builds", id: "b1", attributes: { usesNonExemptEncryption: false } } }, { data: { type: "builds", id: "b1" } })]);
    await s.setNoNonExemptEncryption("b1");
    expect(f.done()).toBe(true);
  });
});

describe("submitForReview", () => {
  const editableUrl = `${B}/v1/apps/app1/appStoreVersions?filter[platform]=IOS&filter[appVersionState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY&limit=5`;
  const openUrl = `${B}/v1/reviewSubmissions?filter[app]=app1&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES`;
  const appRel = { app: { data: { type: "apps", id: "app1" } } };
  const verRel = (id: string) => ({ appStoreVersion: { data: { type: "appStoreVersions", id } } });

  const attach = (v: string) => body("PATCH", `${B}/v1/appStoreVersions/${v}/relationships/build`, { data: { type: "builds", id: "b1" } }, undefined, { status: 204 });
  const locs = (v: string, data: unknown[]) => exact(call("GET", "", { data }), `${B}/v1/appStoreVersions/${v}/appStoreVersionLocalizations?limit=200`);
  const patchLoc = (id: string, whatsNew: string) =>
    body("PATCH", `${B}/v1/appStoreVersionLocalizations/${id}`, { data: { type: "appStoreVersionLocalizations", id, attributes: { whatsNew } } }, { data: { type: "appStoreVersionLocalizations", id } });
  const noPhased = (v: string) => exact(call("GET", "", { data: null }), `${B}/v1/appStoreVersions/${v}/appStoreVersionPhasedRelease`);
  const createPhased = (v: string, status = 201) =>
    body(
      "POST",
      `${B}/v1/appStoreVersionPhasedReleases`,
      { data: { type: "appStoreVersionPhasedReleases", attributes: { phasedReleaseState: "INACTIVE" }, relationships: verRel(v) } },
      status === 201 ? { data: { type: "appStoreVersionPhasedReleases", id: "ph1" } } : { errors: [{ status: "409", code: "ENTITY_ERROR", detail: "The first version can't use phased release." }] },
      { status },
    );
  const item = (v: string, sub: string, status = 201, json?: unknown) =>
    body(
      "POST",
      `${B}/v1/reviewSubmissionItems`,
      { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: sub } }, ...verRel(v) } } },
      json ?? { data: { type: "reviewSubmissionItems", id: "it1" } },
      { status },
    );
  const submit = (sub: string) =>
    body("PATCH", `${B}/v1/reviewSubmissions/${sub}`, { data: { type: "reviewSubmissions", id: sub, attributes: { submitted: true } } }, { data: { type: "reviewSubmissions", id: sub } });

  test("creates a new version, sets What's New everywhere, phased INACTIVE, creates a submission and submits", async () => {
    const notes = "  Faster bill splitting.  ";
    const { s, f } = store([
      exact(call("GET", "", { data: [] }), editableUrl),
      body(
        "POST",
        `${B}/v1/appStoreVersions`,
        { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: "1.4.0", releaseType: "AFTER_APPROVAL" }, relationships: appRel } },
        { data: { type: "appStoreVersions", id: "v9" } },
        { status: 201 },
      ),
      attach("v9"),
      locs("v9", [
        { type: "appStoreVersionLocalizations", id: "l-en", attributes: { locale: "en-US" } },
        { type: "appStoreVersionLocalizations", id: "l-de", attributes: { locale: "de-DE" } },
      ]),
      patchLoc("l-en", "Faster bill splitting."),
      patchLoc("l-de", "Faster bill splitting."),
      noPhased("v9"),
      createPhased("v9"),
      exact(call("GET", "", { data: [] }), openUrl),
      body("POST", `${B}/v1/reviewSubmissions`, { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: appRel } }, { data: { type: "reviewSubmissions", id: "rs1" } }, { status: 201 }),
      item("v9", "rs1"),
      submit("rs1"),
    ]);
    expect(await s.submitForReview({ appId: "app1", version: "1.4.0", buildId: "b1", notes, phased: true })).toEqual({ versionId: "v9" });
    expect(f.done()).toBe(true);
  });

  test("reuses an editable version (renaming it), en-US localization created, existing phased kept, open submission reused, item 409 tolerated", async () => {
    const long = "x".repeat(4100);
    const { s, f } = store([
      exact(call("GET", "", { data: [{ type: "appStoreVersions", id: "v8", attributes: { versionString: "1.3.9", appVersionState: "DEVELOPER_REJECTED" } }] }), editableUrl),
      body("PATCH", `${B}/v1/appStoreVersions/v8`, { data: { type: "appStoreVersions", id: "v8", attributes: { versionString: "1.4.0" } } }, { data: { type: "appStoreVersions", id: "v8" } }),
      attach("v8"),
      locs("v8", []),
      {
        method: "POST",
        url: `${B}/v1/appStoreVersionLocalizations`,
        check: (r) => {
          const d = (r.json as { data: { type: string; attributes: { locale: string; whatsNew: string }; relationships: unknown } }).data;
          expect(d.type).toBe("appStoreVersionLocalizations");
          expect(d.attributes.locale).toBe("en-US");
          expect(d.attributes.whatsNew.length).toBe(4000);
          expect(d.relationships).toEqual(verRel("v8"));
        },
        status: 201,
        json: { data: { type: "appStoreVersionLocalizations", id: "l-en" } },
      },
      call("GET", `${B}/v1/appStoreVersions/v8/appStoreVersionPhasedRelease`, { data: { type: "appStoreVersionPhasedReleases", id: "ph1", attributes: { phasedReleaseState: "INACTIVE" } } }),
      exact(call("GET", "", { data: [{ type: "reviewSubmissions", id: "rs7", attributes: { state: "UNRESOLVED_ISSUES" } }] }), openUrl),
      item("v8", "rs7", 409, { errors: [{ status: "409", code: "ENTITY_ERROR", detail: "An item for this appStoreVersion already exists." }] }),
      exact(
        call("GET", "", { data: [{ type: "reviewSubmissionItems", id: "it1", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v8" } } } }] }),
        `${B}/v1/reviewSubmissions/rs7/items?include=appStoreVersion&limit=50`,
      ),
      submit("rs7"),
    ]);
    expect(await s.submitForReview({ appId: "app1", version: "1.4.0", buildId: "b1", notes: long, phased: true })).toEqual({ versionId: "v8" });
    expect(f.done()).toBe(true);
  });

  test("same version string → no rename; phased off → no phased calls; phased 409 (first version) → continues", async () => {
    const base = (phased: boolean) => [
      exact(call("GET", "", { data: [{ type: "appStoreVersions", id: "v8", attributes: { versionString: "1.4.0" } }] }), editableUrl),
      attach("v8"),
      locs("v8", [{ type: "appStoreVersionLocalizations", id: "l-en" }]),
      patchLoc("l-en", "n"),
      ...(phased ? [noPhased("v8"), createPhased("v8", 409)] : []),
      exact(call("GET", "", { data: [{ type: "reviewSubmissions", id: "rs7" }] }), openUrl),
      item("v8", "rs7"),
      submit("rs7"),
    ];
    for (const phased of [false, true]) {
      const { s, f } = store(base(phased));
      expect(await s.submitForReview({ appId: "app1", version: "1.4.0", buildId: "b1", notes: "n", phased })).toEqual({ versionId: "v8" });
      expect(f.done()).toBe(true);
    }
  });

  test("item 409 for another reason is not swallowed", async () => {
    const { s } = store([
      exact(call("GET", "", { data: [{ type: "appStoreVersions", id: "v8", attributes: { versionString: "1.4.0" } }] }), editableUrl),
      attach("v8"),
      locs("v8", [{ type: "appStoreVersionLocalizations", id: "l-en" }]),
      patchLoc("l-en", "n"),
      exact(call("GET", "", { data: [{ type: "reviewSubmissions", id: "rs7" }] }), openUrl),
      item("v8", "rs7", 409, { errors: [{ status: "409", code: "STATE_ERROR", detail: "Another version is already in review." }] }),
      call("GET", `${B}/v1/reviewSubmissions/rs7/items`, { data: [] }),
    ]);
    await expect(s.submitForReview({ appId: "app1", version: "1.4.0", buildId: "b1", notes: "n", phased: false })).rejects.toThrow("Another version is already in review.");
  });

  test("Apple's 409 on submit becomes a readable message", async () => {
    const { s } = store([
      exact(call("GET", "", { data: [{ type: "appStoreVersions", id: "v8", attributes: { versionString: "1.4.0" } }] }), editableUrl),
      attach("v8"),
      locs("v8", [{ type: "appStoreVersionLocalizations", id: "l-en" }]),
      patchLoc("l-en", "n"),
      exact(call("GET", "", { data: [{ type: "reviewSubmissions", id: "rs7" }] }), openUrl),
      item("v8", "rs7"),
      {
        ...submit("rs7"),
        status: 409,
        json: {
          errors: [
            {
              status: "409",
              code: "STATE_ERROR.ENTITY_STATE_INVALID",
              title: "appStoreVersions with id 'v8' is not in valid state.",
              detail: "This resource cannot be reviewed, please check associated errors to see why.",
              meta: {
                associatedErrors: {
                  "/v1/appScreenshots/": [{ code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "You must upload a screenshot for 6.5-inch iPhone displays." }],
                  "/v1/ageRatingDeclarations/x": [{ code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "You must provide an age rating." }],
                },
              },
            },
          ],
        },
      },
    ]);
    const err = (await s.submitForReview({ appId: "app1", version: "1.4.0", buildId: "b1", notes: "n", phased: false }).catch((e) => e)) as AppStoreError;
    expect(err).toBeInstanceOf(AppStoreError);
    expect(err.status).toBe(409);
    expect(err.message).toBe(
      "App Store Connect: Apple can't accept this yet: This resource cannot be reviewed, please check associated errors to see why.; You must upload a screenshot for 6.5-inch iPhone displays.; You must provide an age rating.",
    );
    expect(err.codes).toEqual(["STATE_ERROR.ENTITY_STATE_INVALID"]);
  });
});

describe("versionState", () => {
  const v = (attrs: Record<string, unknown>, included?: unknown[]) =>
    exact(call("GET", "", { data: { type: "appStoreVersions", id: "v8", attributes: attrs }, ...(included ? { included } : {}) }), `${B}/v1/appStoreVersions/v8?include=appStoreVersionPhasedRelease`);

  test("states and phased release", async () => {
    const { s } = store([
      v({ appVersionState: "WAITING_FOR_REVIEW" }),
      v({ appVersionState: "READY_FOR_DISTRIBUTION" }, [{ type: "appStoreVersionPhasedReleases", id: "ph1", attributes: { phasedReleaseState: "ACTIVE", currentDayNumber: 3 } }]),
      v({ appVersionState: "PENDING_DEVELOPER_RELEASE" }, [{ type: "appStoreVersionPhasedReleases", id: "ph1", attributes: { phasedReleaseState: "INACTIVE" } }]),
      v({ appStoreState: "READY_FOR_SALE" }, [{ type: "appStoreVersionPhasedReleases", id: "ph1", attributes: { phasedReleaseState: "PAUSED", currentDayNumber: 2 } }]),
    ]);
    expect(await s.versionState("v8")).toEqual({ state: "waiting_for_review", phased: null });
    expect(await s.versionState("v8")).toEqual({ state: "ready_for_sale", phased: { state: "active", day: 3 } });
    expect(await s.versionState("v8")).toEqual({ state: "pending_release", phased: { state: "inactive", day: null } });
    expect(await s.versionState("v8")).toEqual({ state: "ready_for_sale", phased: { state: "paused", day: 2 } });
  });

  test("mapVersionState", () => {
    const cases: Array<[string, string]> = [
      ["PREPARE_FOR_SUBMISSION", "ready_for_submit"],
      ["READY_FOR_REVIEW", "ready_for_submit"],
      ["WAITING_FOR_REVIEW", "waiting_for_review"],
      ["IN_REVIEW", "in_review"],
      ["ACCEPTED", "in_review"],
      ["PENDING_APPLE_RELEASE", "in_review"],
      ["PROCESSING_FOR_DISTRIBUTION", "in_review"],
      ["PENDING_DEVELOPER_RELEASE", "pending_release"],
      ["READY_FOR_DISTRIBUTION", "ready_for_sale"],
      ["REJECTED", "rejected"],
      ["METADATA_REJECTED", "rejected"],
      ["INVALID_BINARY", "rejected"],
      ["DEVELOPER_REJECTED", "developer_rejected"],
      ["WAITING_FOR_EXPORT_COMPLIANCE", "processing"],
      ["REPLACED_WITH_NEW_VERSION", "other"],
    ];
    for (const [a, b] of cases) expect([a, mapVersionState(a)]).toEqual([a, b]);
    expect(mapVersionState(undefined, "READY_FOR_SALE")).toBe("ready_for_sale");
    expect(mapVersionState(undefined, undefined)).toBe("other");
  });
});

describe("phased pause/resume and release", () => {
  const phased = call("GET", `${B}/v1/appStoreVersions/v8/appStoreVersionPhasedRelease`, { data: { type: "appStoreVersionPhasedReleases", id: "ph1", attributes: { phasedReleaseState: "ACTIVE" } } });
  const patch = (state: string) =>
    body("PATCH", `${B}/v1/appStoreVersionPhasedReleases/ph1`, { data: { type: "appStoreVersionPhasedReleases", id: "ph1", attributes: { phasedReleaseState: state } } }, { data: { type: "appStoreVersionPhasedReleases", id: "ph1" } });

  test("pause and resume", async () => {
    const { s, f } = store([phased, patch("PAUSED"), phased, patch("ACTIVE")]);
    await s.pausePhased("v8");
    await s.resumePhased("v8");
    expect(f.done()).toBe(true);
  });

  test("no phased release → clear error", async () => {
    const { s } = store([call("GET", "/appStoreVersionPhasedRelease", { errors: [{ status: "404", code: "NOT_FOUND", detail: "no phased release" }] }, { status: 404 })]);
    await expect(s.pausePhased("v8")).rejects.toThrow("this version has no phased release.");
  });

  test("release", async () => {
    const { s, f } = store([
      body(
        "POST",
        `${B}/v1/appStoreVersionReleaseRequests`,
        { data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v8" } } } } },
        { data: { type: "appStoreVersionReleaseRequests", id: "rr1" } },
        { status: 201 },
      ),
    ]);
    await s.release("v8");
    expect(f.done()).toBe(true);
  });
});

describe("transport", () => {
  test("429 is retried", async () => {
    const ok = call("GET", "/v1/appStoreVersions/v8?", { data: { type: "appStoreVersions", id: "v8", attributes: { appVersionState: "IN_REVIEW" } } });
    const { s, f } = store([{ ...ok, status: 429, json: { errors: [{ status: "429", code: "RATE_LIMIT_EXCEEDED" }] } }, ok]);
    expect((await s.versionState("v8")).state).toBe("in_review");
    expect(f.done()).toBe(true);
  });

  test("pure helpers", () => {
    expect(trimWhatsNew("  hi  ")).toBe("hi");
    expect(trimWhatsNew("a".repeat(5000))).toHaveLength(4000);
    expect(describeAppleErrors([{ detail: "A" }, { title: "B" }, { detail: "A" }])).toBe("A; B");
  });
});
