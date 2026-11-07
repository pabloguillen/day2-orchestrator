import { describe, expect, test } from "bun:test";
import { operatorCreds, toolDef, TOOLS } from "./catalog";
import { findVideoPart } from "./providers/gemini-video";
import { KeyCheckError, type CreativeJob, type ToolDeps, type ToolId } from "./types";

/**
 * Every creator tool against a fake of its API: the job is created, polled
 * until done and its media returned (URL or bytes), failures become clear
 * errors (retryable or not), and the key check tells a wrong key from an
 * outage — never echoing the key.
 */

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
function fake(handler: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const deps: ToolDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const body = typeof init?.body === "string" ? (() => { try { return JSON.parse(init.body as string); } catch { return init.body; } })() : init?.body;
      const c = { method: init?.method ?? "GET", url, headers, body };
      calls.push(c);
      return handler(c, calls.length);
    }) as typeof fetch,
    sleep: async () => {},
    pollEveryMs: 1,
  };
  return { calls, deps };
}
const BASE = "http://tool.test";
const presenter: CreativeJob = { capability: "presenter_video", script: "Lerne Vokabeln in fünf Minuten am Tag, ganz ohne Stress.", ratio: "9:16", language: "de", appName: "Dotty" };
const clip: CreativeJob = { capability: "generated_video", prompt: "Slow push-in on the phone.", ratio: "9:16", durationSec: 6, imageUrl: "data:image/jpeg;base64,QUJD", appName: "Dotty" };

describe("HeyGen", () => {
  test("stock avatar, v3 create with idempotency key, poll until completed", async () => {
    let polls = 0;
    const f = fake((c) => {
      if (c.url.pathname === "/v3/avatars/looks") return Response.json({ data: [{ id: "look_stock", name: "Anna", avatar_type: "studio_avatar", default_voice_id: "v_de" }] });
      if (c.url.pathname === "/v3/videos" && c.method === "POST") return Response.json({ data: { video_id: "vid_1", status: "waiting" } });
      if (c.url.pathname === "/v3/videos/vid_1") return Response.json({ data: ++polls < 2 ? { status: "processing" } : { status: "completed", video_url: "https://cdn.heygen.test/v.mp4", duration: 12 } });
      return new Response("nope", { status: 404 });
    });
    const out = await toolDef("heygen").client({ apiKey: "HG-SECRET", baseUrl: BASE }, f.deps).generate(presenter);
    expect(out).toMatchObject({ url: "https://cdn.heygen.test/v.mp4", aiPerson: true, providerJobId: "vid_1", durationSec: 12 });
    expect(out.costUsd).toBeCloseTo(12 * (0.99 / 60), 3);
    const create = f.calls.find((c) => c.method === "POST")!;
    expect(create.headers["x-api-key"]).toBe("HG-SECRET");
    expect(create.headers["idempotency-key"]).toMatch(/^day2-/);
    expect(create.body).toMatchObject({ type: "avatar", avatar_id: "look_stock", voice_id: "v_de", aspect_ratio: "9:16", engine: { type: "avatar_iii" }, voice_settings: { locale: "de-DE" } });
    expect(f.calls[0]!.url.searchParams.get("ownership")).toBe("public");
  });

  test("a failed render is an error with HeyGen's reason", async () => {
    const f = fake((c) => (c.method === "POST" ? Response.json({ data: { video_id: "vid_2" } }) : Response.json({ data: { status: "failed", failure_code: "moderation_rejected", failure_message: "content policy" } })));
    await expect(toolDef("heygen").client({ apiKey: "k", avatarId: "own_look", baseUrl: BASE }, f.deps).generate(presenter)).rejects.toThrow(/moderation_rejected.*content policy/);
  });
});

describe("ElevenLabs", () => {
  test("voiceover: premade voice, multilingual model, mp3 bytes", async () => {
    const f = fake(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }));
    const out = await toolDef("elevenlabs").client({ apiKey: "XI", baseUrl: BASE }, f.deps).generate({ capability: "voice", text: "Hallo du!" });
    expect([...out.bytes!]).toEqual([1, 2, 3]);
    expect(f.calls[0]!.url.pathname).toBe("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    expect(f.calls[0]!.url.searchParams.get("output_format")).toBe("mp3_44100_128");
    expect(f.calls[0]!.headers["xi-api-key"]).toBe("XI");
    expect(f.calls[0]!.body).toMatchObject({ text: "Hallo du!", model_id: "eleven_multilingual_v2" });
  });
  test("music: instrumental, length in ms within 3–600 s", async () => {
    const f = fake(() => new Response(new Uint8Array([9]), { headers: { "content-type": "audio/mpeg" } }));
    await toolDef("elevenlabs").client({ apiKey: "XI", baseUrl: BASE }, f.deps).generate({ capability: "music", prompt: "upbeat", durationSec: 1 });
    expect(f.calls[0]!.url.pathname).toBe("/v1/music");
    expect(f.calls[0]!.body).toMatchObject({ music_length_ms: 3000, force_instrumental: true });
  });
  test("a rejected request isn't retried and never shows the key", async () => {
    const f = fake(() => new Response('{"detail":"invalid xi-api-key XI-SECRET"}', { status: 401 }));
    const err = await toolDef("elevenlabs").client({ apiKey: "XI-SECRET", baseUrl: BASE }, f.deps).generate({ capability: "voice", text: "x" }).catch((e: Error) => e);
    expect(f.calls).toHaveLength(1);
    expect(String((err as Error).message)).not.toContain("XI-SECRET");
  });
});

describe("Google (Gemini Omni)", () => {
  test("one synchronous interaction with the screen as the first frame; video bytes from the answer", async () => {
    const f = fake(() => Response.json({ id: "int_1", status: "completed", steps: [{ content: [{ type: "text", text: "ok" }, { type: "video", data: Buffer.from("MP4").toString("base64"), mime_type: "video/mp4" }] }] }));
    const out = await toolDef("gemini_video").client({ apiKey: "G-KEY", baseUrl: BASE }, f.deps).generate(clip);
    expect(Buffer.from(out.bytes!).toString()).toBe("MP4");
    expect(out.costUsd).toBeCloseTo(0.608, 2);
    const c = f.calls[0]!;
    expect(c.url.pathname).toBe("/v1beta/interactions");
    expect(c.headers["x-goog-api-key"]).toBe("G-KEY");
    expect(c.body.model).toBe("gemini-omni-1.1-flash");
    expect(c.body.input[0]).toEqual({ type: "image", data: "QUJD", mime_type: "image/jpeg" });
    expect(c.body.response_format).toEqual({ type: "video", aspect_ratio: "9:16" });
    expect(c.body.input[1].text).toContain("about 6 seconds");
  });
  test("an answer without a video is an error; the finder walks nested parts", async () => {
    const f = fake(() => Response.json({ steps: [{ content: [{ type: "text", text: "sorry" }] }] }));
    await expect(toolDef("gemini_video").client({ apiKey: "k", baseUrl: BASE }, f.deps).generate(clip)).rejects.toThrow(/no video/);
    expect(findVideoPart({ output: { parts: [{ type: "video", uri: "u" }] } })).toMatchObject({ uri: "u" });
  });
});

describe("Luma", () => {
  test("ray-3.2 video from a start frame; poll until completed; credits charged × $/credit", async () => {
    let n = 0;
    const f = fake((c) => {
      if (c.method === "POST") return Response.json({ id: "gen_1", state: "queued" });
      return Response.json(++n < 3 ? { id: "gen_1", state: "processing" } : { id: "gen_1", state: "completed", output: [{ type: "video", url: "https://luma.test/v.mp4" }], usage: { credits_charged: 100 } });
    });
    const out = await toolDef("luma").client({ apiKey: "luma-api-x", usdPerCredit: "0.02", baseUrl: BASE }, f.deps).generate(clip);
    expect(out).toMatchObject({ url: "https://luma.test/v.mp4", costUsd: 2, providerJobId: "gen_1" });
    const create = f.calls[0]!;
    expect(create.url.pathname).toBe("/v1/generations");
    expect(create.headers.authorization).toBe("Bearer luma-api-x");
    expect(create.body).toMatchObject({ type: "video", model: "ray-3.2", aspect_ratio: "9:16", video: { resolution: "720p", duration: "5s", start_frame: { data: "QUJD" } } });
  });
  test("a failed generation says why", async () => {
    const f = fake((c) => (c.method === "POST" ? Response.json({ id: "gen_2" }) : Response.json({ id: "gen_2", state: "failed", failure_reason: "moderation" })));
    await expect(toolDef("luma").client({ apiKey: "k", baseUrl: BASE }, f.deps).generate(clip)).rejects.toThrow(/gen_2 failed: moderation/);
  });
});

describe("OpenAI Images", () => {
  test("gpt-image-2, portrait size, jpeg; cost from the usage tokens", async () => {
    const f = fake(() => Response.json({ data: [{ b64_json: Buffer.from("JPG").toString("base64") }], usage: { input_tokens: 100, output_tokens: 2000 } }));
    const out = await toolDef("openai_images").client({ apiKey: "sk-x", baseUrl: BASE }, f.deps).generate({ capability: "image", prompt: "soft shapes", ratio: "4:5", appName: "Dotty" });
    expect(Buffer.from(out.bytes!).toString()).toBe("JPG");
    expect(out.costUsd).toBeCloseTo(0.03, 3);
    expect(f.calls[0]!.body).toMatchObject({ model: "gpt-image-2", size: "1024x1536", output_format: "jpeg", moderation: "auto" });
  });
});

describe("Runway and Creatify through the registry", () => {
  test("Runway: image_to_video job from a generated_video job", async () => {
    const f = fake((c) => (c.method === "POST" ? Response.json({ id: "task_1" }) : Response.json({ id: "task_1", status: "SUCCEEDED", output: ["https://runway.test/o.mp4"], cost: { credits: 60 } })));
    const out = await toolDef("runway").client({ apiSecret: "rw", baseUrl: BASE }, f.deps).generate(clip);
    expect(out).toMatchObject({ url: "https://runway.test/o.mp4", costUsd: 0.6 });
    expect(f.calls[0]!.url.pathname).toBe("/v1/image_to_video");
  });
  test("Creatify: avatar_ad from a presenter job", async () => {
    const f = fake((c) => {
      if (c.url.pathname === "/api/lipsyncs/" && c.method === "POST") return Response.json({ id: "ls_1", status: "pending" });
      if (c.url.pathname === "/api/lipsyncs/ls_1/") return Response.json({ id: "ls_1", status: "done", output: "https://creatify.test/o.mp4", credits_used: 5 });
      return Response.json([]);
    });
    const out = await toolDef("creatify").client({ apiId: "id", apiKey: "k", avatarId: "stock_1", baseUrl: BASE }, f.deps).generate(presenter);
    expect(out).toMatchObject({ url: "https://creatify.test/o.mp4", aiPerson: true });
  });
});

describe("key checks", () => {
  const creds: Record<ToolId, Record<string, string>> = {
    runway: { apiSecret: "S3CRET" },
    creatify: { apiId: "S3CRET", apiKey: "S3CRET" },
    heygen: { apiKey: "S3CRET" },
    elevenlabs: { apiKey: "S3CRET" },
    gemini_video: { apiKey: "S3CRET" },
    luma: { apiKey: "S3CRET" },
    openai_images: { apiKey: "S3CRET" },
  };
  for (const t of TOOLS) {
    test(`${t.name}: one cheap GET; 401 → rejected, 503 → not checked yet`, async () => {
      const ok = fake(() => Response.json({ data: [] }));
      await t.verify({ ...creds[t.id], baseUrl: BASE }, ok.deps);
      expect(ok.calls).toHaveLength(1);
      expect(ok.calls[0]!.method).toBe("GET");
      const bad = fake(() => new Response("bad key S3CRET", { status: 401 }));
      const e1 = (await t.verify({ ...creds[t.id], baseUrl: BASE }, bad.deps).catch((e) => e)) as KeyCheckError;
      expect(e1).toBeInstanceOf(KeyCheckError);
      expect(e1.rejected).toBe(true);
      expect(e1.message).not.toContain("S3CRET");
      const down = fake(() => new Response("oops", { status: 503 }));
      const e2 = (await t.verify({ ...creds[t.id], baseUrl: BASE }, down.deps).catch((e) => e)) as KeyCheckError;
      expect(e2.rejected).toBe(false);
    });
  }
});

describe("day2's account from the operator's env", () => {
  test("each tool's env; Runway still needs DAY2_ADS_RUNWAY=on", () => {
    const ops = operatorCreds({ HEYGEN_API_KEY: "h", ELEVENLABS_API_KEY: "e", GEMINI_API_KEY: "g", LUMA_API_KEY: "l", OPENAI_API_KEY: "o", CREATIFY_API_ID: "i", CREATIFY_API_KEY: "k", RUNWAYML_API_SECRET: "r" });
    expect(Object.keys(ops).sort()).toEqual(["creatify", "elevenlabs", "gemini_video", "heygen", "luma", "openai_images"]);
    expect(operatorCreds({ RUNWAYML_API_SECRET: "r", DAY2_ADS_RUNWAY: "on" }).runway).toMatchObject({ apiSecret: "r" });
  });
});
