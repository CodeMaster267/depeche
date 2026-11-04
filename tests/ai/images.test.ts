import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MODELS, canSearch, chooseDefault, findModel, priceBand } from "@/lib/ai/models";
import { askedAspect, imageCost, imageHold, openaiSize, pictureName } from "@/lib/ai/image-cost";

vi.mock("server-only", () => ({}));

const { makePicture, stripes } = await import("@/lib/ai/images");
const { ProviderError } = await import("@/lib/ai/providers");
const { staleKeys } = await import("@/lib/ai/key-models");

/**
 * Picture models are tested against a local stand-in that answers the way each provider's API
 * does, so Depeche's own request building and reading run for real without spending anything.
 */
type Reply = { status?: number; json?: unknown };
let handler: (path: string, raw: string) => Reply = () => ({ status: 500, json: { error: { message: "no handler" } } });
const seen: { path: string; raw: string; type?: string }[] = [];
let server: Server;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => r(Buffer.concat(parts).toString("latin1")));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    seen.push({ path: req.url ?? "", raw, type: req.headers["content-type"] });
    const out = handler(req.url ?? "", raw);
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.json ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("DEPECHE_OPENAI_URL", url);
  vi.stubEnv("DEPECHE_GOOGLE_URL", url);
  vi.stubEnv("DEPECHE_XAI_URL", url);
  vi.stubEnv("DEPECHE_FAKE_AI", "0");
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});
afterEach(() => (seen.length = 0));

const PNG = stripes(false, 8);
const b64 = PNG.toString("base64");
const ask = (id: string, prompt: string, images: { mime: string; data: Buffer }[] = []) =>
  makePicture({ model: findModel(id)!, apiKey: "sk-test", prompt, images, signal: new AbortController().signal });

describe("picture models in the list", () => {
  it("are offered by OpenAI, Google and xAI, never searched with, and never a new chat's default", () => {
    const pictures = MODELS.filter((m) => m.image);
    expect(pictures.map((m) => m.provider).sort()).toEqual(["google", "google", "openai", "openai", "xai"]);
    for (const m of pictures) {
      expect(canSearch(m)).toBe(false);
      expect(priceBand(m)).toMatch(/^\$+$/);
    }
    const flare = findModel("gpt-image-2.5-flare")!;
    const sol = findModel("gpt-6.1-sol")!;
    expect(chooseDefault([flare, sol], "gpt-image-2.5-flare")?.id).toBe("gpt-6.1-sol");
    expect(chooseDefault([flare])?.id).toBe("gpt-image-2.5-flare");
  });

  it("rechecks keys checked before picture models were added, so they show up", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(staleKeys([{ provider: "openai", models: ["gpt-6.1-sol"], checked_at: "2026-11-03T22:00:00Z" }])).toHaveLength(1);
    expect(staleKeys([{ provider: "openai", models: ["gpt-6.1-sol", "gpt-image-2.5-flare"], checked_at: recent }])).toHaveLength(0);
    // Anthropic has no picture models, so its keys aren't asked again.
    expect(staleKeys([{ provider: "anthropic", models: ["claude-sonnet-5-5"], checked_at: recent }])).toHaveLength(0);
  });
});

describe("picture spending", () => {
  it("holds the most a picture could cost, more for each picture to edit", () => {
    const flare = findModel("gpt-image-2.5-flare")!;
    const one = imageHold(flare, "a cat", 0);
    expect(one).toBeGreaterThan(0.12);
    expect(one).toBeLessThan(0.13);
    expect(imageHold(flare, "a cat", 2)).toBeCloseTo(one + 0.12, 5);
    // At most five pictures are sent, so the hold stops growing there.
    expect(imageHold(flare, "a cat", 9)).toBeCloseTo(imageHold(flare, "a cat", 5), 6);
  });

  it("counts OpenAI and Google by the tokens they report, and xAI per picture", () => {
    const flare = findModel("gpt-image-2.5-flare")!;
    // 100 text tokens at $5, 1,000 picture tokens in at $8, 4,000 out at $30 per million.
    expect(imageCost(flare, { textIn: 100, imagesIn: 1000, imageOut: 4000, textOut: 0 }, 1, 1)).toBeCloseTo(0.1285, 6);
    const nano = findModel("gemini-nano-banana-2.1")!;
    // A 1K picture is 1,120 tokens: $0.0336, plus thinking at $12 per million.
    expect(imageCost(nano, { textIn: 0, imagesIn: 0, imageOut: 1120, textOut: 500 }, 0, 1)).toBeCloseTo(0.0336 + 0.006, 6);
    const grok = findModel("grok-imagine-image-2.0")!;
    expect(imageCost(grok, undefined, 0, 1)).toBeCloseTo(0.04);
    expect(imageCost(grok, undefined, 1, 1)).toBeCloseTo(0.06);
    // A higher reported charge wins; a nonsense one is ignored.
    expect(imageCost(grok, { textIn: 0, imagesIn: 0, imageOut: 0, textOut: 0, reportedUsd: 0.07 }, 0, 1)).toBeCloseTo(0.07);
    expect(imageCost(grok, { textIn: 0, imagesIn: 0, imageOut: 0, textOut: 0, reportedUsd: 900 }, 0, 1)).toBeCloseTo(0.04);
    // No report at all: the hold is counted.
    expect(imageCost(flare, undefined, 0, 1)).toBeCloseTo(0.12);
  });

  it("reads asked-for shapes and names pictures after what was asked", () => {
    expect(askedAspect("a beach, 16:9")).toBe("16:9");
    expect(askedAspect("a 9x16 phone wallpaper")).toBe("9:16");
    expect(askedAspect("meet at 10:30")).toBeUndefined();
    expect(openaiSize(undefined)).toBe("auto");
    expect(openaiSize("1:1")).toBe("1024x1024");
    const [w, h] = openaiSize("16:9").split("x").map(Number);
    expect(w % 16 + (h % 16)).toBe(0);
    expect(w / h).toBeCloseTo(16 / 9, 1);
    expect(pictureName("A cat in a hat, on the moon!", "image/jpeg")).toBe("A-cat-in-a-hat-on.jpg");
    expect(pictureName("¿?", "image/png")).toBe("Picture.png");
  });
});

describe("OpenAI pictures", () => {
  it("makes a picture as a JPEG at medium quality on Flare", async () => {
    handler = () => ({ json: { data: [{ b64_json: b64 }], usage: { input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 1000, total_tokens: 1020 } } });
    const out = await ask("gpt-image-2.5-flare", "a lighthouse at dusk");
    expect(seen[0].path).toBe("/images/generations");
    const body = JSON.parse(seen[0].raw);
    expect(body).toMatchObject({ model: "gpt-image-2.5-flare", quality: "medium", output_format: "jpeg", size: "auto", n: 1 });
    expect(out.images).toHaveLength(1);
    expect(out.images[0].data.equals(PNG)).toBe(true);
    expect(out.usage).toEqual({ textIn: 20, imagesIn: 0, imageOut: 1000, textOut: 0 });
  });

  it("edits the attached pictures, at high quality on Sunburst", async () => {
    handler = () => ({ json: { data: [{ b64_json: b64 }] } });
    await ask("gpt-image-2.5-sunburst", "make the sky purple", [{ mime: "image/png", data: PNG }, { mime: "image/jpeg", data: PNG }]);
    expect(seen[0].path).toBe("/images/edits");
    expect(seen[0].type).toMatch(/multipart\/form-data/);
    expect(seen[0].raw).toContain("picture-1.png");
    expect(seen[0].raw).toContain("picture-2.jpg");
    expect(seen[0].raw).toContain("make the sky purple");
    expect(seen[0].raw).toMatch(/name="quality"\r\n\r\nhigh/);
  });

  it("says plainly when the safety check turns a picture down", async () => {
    handler = () => ({ status: 400, json: { error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked" } } });
    const err = await ask("gpt-image-2.5-flare", "something").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/safety check turned this picture down/);
  });
});

describe("Google pictures", () => {
  it("sends the picture to edit and the words, and reads the picture and usage back", async () => {
    handler = () => ({
      json: {
        candidates: [{ content: { role: "model", parts: [{ text: "thinking…", thought: true }, { inlineData: { mimeType: "image/png", data: b64 } }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 300, promptTokensDetails: [{ modality: "TEXT", tokenCount: 40 }, { modality: "IMAGE", tokenCount: 260 }],
          candidatesTokenCount: 1120, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }], thoughtsTokenCount: 200,
        },
      },
    });
    const out = await ask("gemini-nano-banana-2.1", "add a red hat, 3:4", [{ mime: "image/png", data: PNG }]);
    expect(seen[0].path).toMatch(/models\/gemini-nano-banana-2\.1:generateContent/);
    const body = JSON.parse(seen[0].raw);
    expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: "image/png", data: b64 });
    expect(body.contents[0].parts[1].text).toBe("add a red hat, 3:4");
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "3:4" });
    expect(out.images).toHaveLength(1);
    expect(out.text).toBe("");
    expect(out.usage).toEqual({ textIn: 40, imagesIn: 260, imageOut: 1120, textOut: 200 });
  });

  it("explains that free keys can't make pictures", async () => {
    handler = () => ({ status: 429, json: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0" } } });
    const err = await ask("gemini-nano-banana-2.1", "a cat").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/don't work on a free key/);
  });

  it("reports a safety stop rather than an empty reply", async () => {
    handler = () => ({ json: { candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }] } });
    const err = await ask("gemini-3-pro-image", "a cat").catch((e) => e);
    expect(err.message).toMatch(/safety check/);
  });
});

describe("xAI pictures", () => {
  it("makes a picture and counts what xAI reports it charged", async () => {
    handler = () => ({ json: { data: [{ b64_json: b64, mime_type: "image/jpeg" }], usage: { cost_in_usd_ticks: 500_000_000 } } });
    const out = await ask("grok-imagine-image-2.0", "a fox, 16:9");
    expect(seen[0].path).toBe("/images/generations");
    expect(JSON.parse(seen[0].raw)).toMatchObject({ model: "grok-imagine-image-2.0", response_format: "b64_json", aspect_ratio: "16:9" });
    expect(out.images[0].mime).toBe("image/jpeg");
    expect(out.usage?.reportedUsd).toBeCloseTo(0.05);
  });

  it("edits only the first picture, sent as a data address", async () => {
    handler = () => ({ json: { data: [{ b64_json: b64 }] } });
    await ask("grok-imagine-image-2.0", "make it night", [{ mime: "image/png", data: PNG }, { mime: "image/png", data: PNG }]);
    expect(seen[0].path).toBe("/images/edits");
    const body = JSON.parse(seen[0].raw);
    expect(body.image).toEqual({ url: `data:image/png;base64,${b64}`, type: "image_url" });
  });
});
