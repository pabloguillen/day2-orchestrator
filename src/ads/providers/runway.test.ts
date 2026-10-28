import { describe, expect, test } from "bun:test";
import { noSleep, scriptedFetch } from "../test-helpers";
import { createRunway, runwayFromEnv } from "./runway";
import { ProviderError, type VideoJob } from "./video";

const creds = { apiSecret: "key_secret123", model: "gen4.5" as const, usdPerCredit: 0.01 };
const job: VideoJob = { kind: "image_to_video", ratio: "9:16", durationSec: 5, imageUrl: "https://day2.example/api/assets/shot.png", prompt: "Slow push-in on the dashboard", appName: "Buddy" };

describe("runwayFromEnv", () => {
  test("missing secret → null", () => {
    expect(runwayFromEnv({})).toBeNull();
    expect(runwayFromEnv({ RUNWAYML_API_SECRET: "  " })).toBeNull();
  });
  test("reads secret, model and price", () => {
    expect(runwayFromEnv({ RUNWAYML_API_SECRET: "s" })).toEqual({ apiSecret: "s", model: "gen4.5", usdPerCredit: 0.01 });
    expect(runwayFromEnv({ RUNWAYML_API_SECRET: "s", RUNWAY_MODEL: "gen4_turbo", RUNWAY_USD_PER_CREDIT: "0.009" })).toEqual({ apiSecret: "s", model: "gen4_turbo", usdPerCredit: 0.009 });
  });
  test("unknown model is refused", () => {
    expect(() => runwayFromEnv({ RUNWAYML_API_SECRET: "s", RUNWAY_MODEL: "gen9" })).toThrow(ProviderError);
  });
});

describe("runway image_to_video", () => {
  test("creates the task, polls through pending states, maps the result", async () => {
    const f = scriptedFetch([
      {
        method: "POST",
        url: "https://api.dev.runwayml.com/v1/image_to_video",
        check: (r) => {
          expect(r.headers.authorization).toBe("Bearer key_secret123");
          expect(r.headers["x-runway-version"]).toBe("2024-11-06");
          expect(r.json).toEqual({
            model: "gen4.5",
            promptImage: [{ uri: "https://day2.example/api/assets/shot.png", position: "first" }],
            promptText: "Slow push-in on the dashboard",
            ratio: "720:1280",
            duration: 5,
          });
        },
        json: { id: "task_1", estimatedCost: { credits: 60 } },
      },
      { method: "GET", url: "/v1/tasks/task_1", json: { id: "task_1", status: "PENDING" } },
      { method: "GET", url: "/v1/tasks/task_1", json: { id: "task_1", status: "THROTTLED" } },
      { method: "GET", url: "/v1/tasks/task_1", json: { id: "task_1", status: "RUNNING", progress: 0.5 } },
      { method: "GET", url: "/v1/tasks/task_1", json: { id: "task_1", status: "SUCCEEDED", output: ["https://dnznrvs05pmza.cloudfront.net/out.mp4"], cost: { credits: 60 } } },
    ]);
    const rw = createRunway(creds, { fetch: f.fetch, sleep: noSleep });
    expect(rw.estimateUsd(job)).toBe(0.6);
    const res = await rw.generate(job);
    expect(res).toEqual({ url: "https://dnznrvs05pmza.cloudfront.net/out.mp4", durationSec: 5, aiPerson: false, costUsd: 0.6, providerJobId: "task_1" });
    expect(f.done()).toBe(true);
  });

  test("maps ratio, clamps duration, uses a default prompt", async () => {
    const f = scriptedFetch([
      {
        url: "/v1/image_to_video",
        check: (r) => {
          const b = r.json as Record<string, unknown>;
          expect(b.ratio).toBe("960:960");
          expect(b.duration).toBe(10);
          expect(b.model).toBe("gen4_turbo");
          expect(typeof b.promptText).toBe("string");
        },
        json: { id: "t2" },
      },
      { url: "/v1/tasks/t2", json: { id: "t2", status: "SUCCEEDED", output: ["https://x/o.mp4"] } },
    ]);
    const rw = createRunway({ ...creds, model: "gen4_turbo" }, { fetch: f.fetch, sleep: noSleep });
    const res = await rw.generate({ ...job, ratio: "1:1", durationSec: 30, prompt: undefined });
    expect(res.costUsd).toBe(0.5); // 5 credits/s × 10 s, no cost reported → estimate
  });

  test("FAILED → ProviderError (retryable only for INTERNAL codes)", async () => {
    const f = scriptedFetch([
      { url: "/v1/image_to_video", json: { id: "t3" } },
      { url: "/v1/tasks/t3", json: { id: "t3", status: "RUNNING" } },
      { url: "/v1/tasks/t3", json: { id: "t3", status: "FAILED", failure: "Input image flagged", failureCode: "SAFETY.INPUT.IMAGE" } },
    ]);
    const err = await createRunway(creds, { fetch: f.fetch, sleep: noSleep }).generate(job).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("SAFETY.INPUT.IMAGE");
    expect(err.retryable).toBe(false);

    const g = scriptedFetch([
      { url: "/v1/image_to_video", json: { id: "t4" } },
      { url: "/v1/tasks/t4", json: { id: "t4", status: "FAILED", failure: "oops", failureCode: "INTERNAL.BAD_OUTPUT.CODE01" } },
    ]);
    const err2 = await createRunway(creds, { fetch: g.fetch, sleep: noSleep }).generate(job).catch((e) => e);
    expect(err2.retryable).toBe(true);
  });

  test("retries a 429 on task creation", async () => {
    const f = scriptedFetch([
      { url: "/v1/image_to_video", status: 429, json: { error: "rate limited" }, headers: { "retry-after": "1" } },
      { url: "/v1/image_to_video", json: { id: "t5" } },
      { url: "/v1/tasks/t5", json: { id: "t5", status: "SUCCEEDED", output: ["https://x/o.mp4"], cost: { credits: 60 } } },
    ]);
    const res = await createRunway(creds, { fetch: f.fetch, sleep: noSleep }).generate(job);
    expect(res.providerJobId).toBe("t5");
    expect(f.done()).toBe(true);
  });

  test("4xx is a non-retryable ProviderError without leaking the secret", async () => {
    const f = scriptedFetch([{ url: "/v1/image_to_video", status: 400, json: { error: "Invalid ratio" } }]);
    const err = await createRunway(creds, { fetch: f.fetch, sleep: noSleep }).generate(job).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("key_secret123");
  });

  test("rejects bad input without calling the API", async () => {
    const f = scriptedFetch([]);
    const rw = createRunway(creds, { fetch: f.fetch, sleep: noSleep });
    await expect(rw.generate({ ...job, imageUrl: undefined })).rejects.toBeInstanceOf(ProviderError);
    await expect(rw.generate({ ...job, imageUrl: "http://insecure/x.png" })).rejects.toBeInstanceOf(ProviderError);
    await expect(rw.generate({ ...job, kind: "avatar_ad" })).rejects.toBeInstanceOf(ProviderError);
    expect(f.calls.length).toBe(0);
  });
});
