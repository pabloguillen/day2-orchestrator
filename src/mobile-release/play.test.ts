import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { scriptedFetch, type Expect, type Recorded } from "../ads/test-helpers";
import { createPlay, serviceAccountJwt, trimNotes } from "./play";
import type { PlayCredential } from "./credentials";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const cred: PlayCredential = {
  clientEmail: "day2@proj.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  projectId: "proj",
};
const NOW = new Date("2026-10-31T10:00:00.000Z");
const PKG = "com.buddy.app";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const EDIT = `${API}/applications/${PKG}/edits/ed1`;

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

const tokenCall: Expect = {
  method: "POST",
  url: "https://oauth2.googleapis.com/token",
  check: (r) => {
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = r.json as Record<string, string>;
    expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.assertion!.split(".");
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(decode(c!)).toEqual({ iss: cred.clientEmail, scope: "https://www.googleapis.com/auth/androidpublisher", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  },
  json: { access_token: "ya29.play", expires_in: 3599, token_type: "Bearer" },
};

const authed = (r: Recorded) => expect(r.headers.authorization).toBe("Bearer ya29.play");

const insert: Expect = {
  method: "POST",
  url: `${API}/applications/${PKG}/edits`,
  check: (r) => {
    authed(r);
    expect(r.url).toBe(`${API}/applications/${PKG}/edits`);
    expect(r.json).toEqual({});
  },
  json: { id: "ed1", expiryTimeSeconds: "1793000000" },
};
const getTrack = (releases: unknown[]): Expect => ({ method: "GET", url: `${EDIT}/tracks/production`, check: authed, json: { track: "production", releases } });
const putTrack = (expected: unknown[], respond = true): Expect => ({
  method: "PUT",
  url: `${EDIT}/tracks/production`,
  check: (r) => {
    authed(r);
    expect(r.url).toBe(`${EDIT}/tracks/production`);
    expect(r.json).toEqual({ track: "production", releases: expected });
  },
  json: respond ? { track: "production", releases: expected } : undefined,
});
const validate: Expect = { method: "POST", url: `${EDIT}:validate`, check: (r) => expect(r.url).toBe(`${EDIT}:validate`), json: { id: "ed1" } };
const commit: Expect = { method: "POST", url: `${EDIT}:commit`, check: (r) => expect(r.url).toBe(`${EDIT}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`), json: { id: "ed1" } };
const del: Expect = { method: "DELETE", url: EDIT, check: (r) => expect(r.url).toBe(EDIT) };
const googleError = (status: number, message: string) => ({ status, json: { error: { code: status, message, status: "FAILED_PRECONDITION" } } });

const previous = { name: "1.4.0", versionCodes: ["41"], status: "completed", releaseNotes: [{ language: "de-DE", text: "Fehlerbehebungen" }] };
const ours = (over: Record<string, unknown> = {}) => ({ name: "1.5.0", versionCodes: ["42"], status: "inProgress", userFraction: 0.05, releaseNotes: [{ language: "de-DE", text: "Neu: Gruppen" }], ...over });

function setup(script: Expect[]) {
  const s = scriptedFetch(script);
  return { s, play: createPlay(cred, { fetch: s.fetch, now: () => NOW }) };
}

describe("auth", () => {
  test("service-account JWT is RS256 with the androidpublisher claims, token cached", async () => {
    const { s, play } = setup([tokenCall, insert, getTrack([ours()]), putTrack([ours({ status: "halted" })]), validate, commit, insert, getTrack([ours({ status: "halted" })]), putTrack([ours({ status: "halted" })]), validate, commit]);
    await play.halt({ packageName: PKG, versionCode: "42" });
    await play.halt({ packageName: PKG, versionCode: "42" });
    expect(s.done()).toBe(true);
    expect(s.calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
  });

  test("jwt helper accepts keys with literal \\n", () => {
    const jwt = serviceAccountJwt({ ...cred, privateKey: cred.privateKey.replace(/\n/g, "\\n") }, NOW);
    expect(jwt.split(".").length).toBe(3);
  });
});

describe("promote", () => {
  test("keeps the previous completed release, adds ours inProgress with fraction and notes in the track's language", async () => {
    const { s, play } = setup([tokenCall, insert, getTrack([previous]), putTrack([previous, ours()]), validate, commit]);
    await play.promote({ packageName: PKG, versionCode: "42", fraction: 0.05, notes: "  Neu: Gruppen \n", name: "1.5.0" });
    expect(s.done()).toBe(true);
  });

  test("en-US when no notes exist; notes trimmed to 500; other version's in-progress release superseded", async () => {
    const long = "x".repeat(600);
    const stale = { name: "1.4.5", versionCodes: ["40"], status: "halted", userFraction: 0.1 };
    const expected = { name: "1.5.0", versionCodes: ["42"], status: "inProgress", userFraction: 0.1, releaseNotes: [{ language: "en-US", text: trimNotes(long) }] };
    const { s, play } = setup([tokenCall, insert, getTrack([{ ...previous, releaseNotes: undefined }, stale]), putTrack([{ ...previous, releaseNotes: undefined }, expected]), validate, commit]);
    await play.promote({ packageName: PKG, versionCode: "42", fraction: 0.1, notes: long, name: "1.5.0" });
    expect(s.done()).toBe(true);
    expect(trimNotes(long).length).toBe(500);
  });

  test("fraction >= 1 promotes as completed and drops the previous completed release", async () => {
    const { s, play } = setup([
      tokenCall,
      insert,
      getTrack([previous]),
      putTrack([{ name: "1.5.0", versionCodes: ["42"], status: "completed", releaseNotes: [{ language: "de-DE", text: "Neu" }] }]),
      validate,
      commit,
    ]);
    await play.promote({ packageName: PKG, versionCode: "42", fraction: 1, notes: "Neu", name: "1.5.0" });
    expect(s.done()).toBe(true);
  });

  test("draft app: clear error, edit deleted", async () => {
    const { s, play } = setup([
      tokenCall,
      insert,
      getTrack([]),
      { method: "PUT", url: `${EDIT}/tracks/production`, ...googleError(400, "Only releases with status draft may be created on draft app.") },
      del,
    ]);
    await expect(play.promote({ packageName: PKG, versionCode: "42", fraction: 0.05, notes: "n", name: "1.5.0" })).rejects.toThrow(
      "the app has never been published on Google Play; publish the first release in Play Console",
    );
    expect(s.done()).toBe(true);
  });
});

describe("rollout changes", () => {
  test("setFraction 0.2 keeps the previous release and our notes", async () => {
    const { s, play } = setup([tokenCall, insert, getTrack([previous, ours()]), putTrack([previous, ours({ userFraction: 0.2 })]), validate, commit]);
    await play.setFraction({ packageName: PKG, versionCode: "42", fraction: 0.2 });
    expect(s.done()).toBe(true);
  });

  test("setFraction 1 completes: drops userFraction and the previous completed release", async () => {
    const { userFraction: _, ...rest } = ours();
    const { s, play } = setup([tokenCall, insert, getTrack([previous, ours({ userFraction: 0.5 })]), putTrack([{ ...rest, status: "completed" }]), validate, commit]);
    await play.setFraction({ packageName: PKG, versionCode: "42", fraction: 1 });
    expect(s.done()).toBe(true);
  });

  test("halt keeps userFraction and the previous release", async () => {
    const { s, play } = setup([tokenCall, insert, getTrack([previous, ours({ userFraction: 0.2 })]), putTrack([previous, ours({ status: "halted", userFraction: 0.2 })]), validate, commit]);
    await play.halt({ packageName: PKG, versionCode: "42" });
    expect(s.done()).toBe(true);
  });

  test("complete from halted", async () => {
    const { userFraction: _, ...rest } = ours();
    const { s, play } = setup([tokenCall, insert, getTrack([previous, ours({ status: "halted" })]), putTrack([{ ...rest, status: "completed" }]), validate, commit]);
    await play.complete({ packageName: PKG, versionCode: "42" });
    expect(s.done()).toBe(true);
  });

  test("unknown version code: error, edit deleted, nothing written", async () => {
    const { s, play } = setup([tokenCall, insert, getTrack([previous]), del]);
    await expect(play.setFraction({ packageName: PKG, versionCode: "42", fraction: 0.2 })).rejects.toThrow("version code 42 isn't on the production track");
    expect(s.done()).toBe(true);
  });

  test("validate failure surfaces Google's message and deletes the edit", async () => {
    const { s, play } = setup([tokenCall, insert, getTrack([previous, ours()]), putTrack([previous, ours({ userFraction: 0.2 })]), { method: "POST", url: `${EDIT}:validate`, ...googleError(400, "Version code 42 has no APK.") }, del]);
    await expect(play.setFraction({ packageName: PKG, versionCode: "42", fraction: 0.2 })).rejects.toThrow("Google Play: 400 Version code 42 has no APK.");
    expect(s.done()).toBe(true);
  });

  test("commit needing changesNotSentForReview: clear error, not retried, edit deleted", async () => {
    const { s, play } = setup([
      tokenCall,
      insert,
      getTrack([previous, ours()]),
      putTrack([previous, ours({ userFraction: 0.2 })]),
      validate,
      { method: "POST", url: `${EDIT}:commit`, ...googleError(400, "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.") },
      del,
    ]);
    await expect(play.setFraction({ packageName: PKG, versionCode: "42", fraction: 0.2 })).rejects.toThrow("changes are waiting in Play Console from a previous rejection");
    expect(s.done()).toBe(true);
    expect(s.calls.some((c) => c.url.includes("changesNotSentForReview"))).toBe(false);
  });

  test("tokens are redacted from errors", async () => {
    const { play } = setup([tokenCall, { method: "POST", url: `${API}/applications/${PKG}/edits`, status: 403, json: { error: { message: "denied for Bearer ya29.play" } } }]);
    const err = await play.halt({ packageName: PKG, versionCode: "42" }).catch((e: Error) => e);
    expect(String(err)).toContain("Bearer [redacted]");
    expect(String(err)).not.toContain("ya29.play");
  });

  test("operations on one package are serialised (one edit at a time)", async () => {
    const { s, play } = setup([
      tokenCall,
      insert,
      getTrack([previous, ours()]),
      putTrack([previous, ours({ userFraction: 0.2 })]),
      validate,
      commit,
      insert,
      getTrack([previous, ours({ userFraction: 0.2 })]),
      putTrack([previous, ours({ status: "halted", userFraction: 0.2 })]),
      validate,
      commit,
    ]);
    await Promise.all([play.setFraction({ packageName: PKG, versionCode: "42", fraction: 0.2 }), play.halt({ packageName: PKG, versionCode: "42" })]);
    expect(s.done()).toBe(true);
  });
});

describe("status", () => {
  const listCall = (state: string): Expect => ({
    method: "GET",
    url: `${API}/applications/${PKG}/tracks/production/releases`,
    check: authed,
    json: {
      releases: [
        { releaseName: "1.4.0", track: "production", activeArtifacts: [{ versionCode: 41 }], releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" },
        { releaseName: "1.5.0", track: "production", activeArtifacts: [{ versionCode: 42 }], releaseLifecycleState: state },
      ],
    },
  });

  test.each([
    ["RELEASE_LIFECYCLE_STATE_DRAFT", "draft"],
    ["RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW", "not_sent"],
    ["RELEASE_LIFECYCLE_STATE_IN_REVIEW", "in_review"],
    ["RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED", "approved_not_published"],
    ["RELEASE_LIFECYCLE_STATE_NOT_APPROVED", "rejected"],
    ["RELEASE_LIFECYCLE_STATE_PUBLISHED", "published"],
    ["RELEASE_LIFECYCLE_STATE_UNSPECIFIED", "unknown"],
    ["SOMETHING_NEW", "unknown"],
  ])("%s → %s, with track status/fraction from an uncommitted edit", async (state, lifecycle) => {
    const { s, play } = setup([tokenCall, listCall(state), insert, getTrack([previous, ours({ userFraction: 0.2 })]), del]);
    expect(await play.status({ packageName: PKG, versionCode: "42" })).toEqual({ lifecycle: lifecycle as never, status: "inProgress", fraction: 0.2 });
    expect(s.done()).toBe(true);
    expect(s.calls.some((c) => c.url.includes(":commit"))).toBe(false);
  });

  test("not on the track yet", async () => {
    const { s, play } = setup([tokenCall, { method: "GET", url: `${API}/applications/${PKG}/tracks/production/releases`, json: {} }, insert, getTrack([previous]), del]);
    expect(await play.status({ packageName: PKG, versionCode: "42" })).toEqual({ lifecycle: "unknown", status: null, fraction: null });
    expect(s.done()).toBe(true);
  });
});
