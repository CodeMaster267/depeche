import "server-only";
import { deflateSync } from "node:zlib";
import OpenAI, { toFile } from "openai";
import { GoogleGenAI, type Part } from "@google/genai";
import { PROVIDER_NAME, type Model } from "@/lib/ai/models";
import { MAX_IMAGES_IN, askedAspect, openaiSize, type ImageUsage } from "@/lib/ai/image-cost";
import { ProviderError, describe, detail, fakeAi, status } from "@/lib/ai/providers";

/**
 * Making and editing pictures with the family's own keys. Each request sends the description and
 * any pictures to edit, and gets pictures back. Nothing here runs model output: pictures are
 * stored as files and shown with <img>.
 */
export type Picture = { mime: string; data: Buffer };

export type PictureRequest = {
  model: Model;
  apiKey: string;
  prompt: string;
  /** Pictures to edit or use as references; none means a new picture. */
  images: Picture[];
  signal: AbortSignal;
};

export type PictureResult = { images: Picture[]; text: string; usage?: ImageUsage };

/** Picture models can take a minute or two, but never longer than the request may run. */
const TIMEOUT_MS = 240_000;

/** The kinds each provider takes to edit. GIFs are left out (OpenAI and xAI refuse them). */
const EDITABLE = ["image/png", "image/jpeg", "image/webp"];

export async function makePicture(req: PictureRequest): Promise<PictureResult> {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const images = req.images.filter((i) => EDITABLE.includes(i.mime)).slice(0, req.model.provider === "xai" ? 1 : MAX_IMAGES_IN);
  const r = { ...req, images, signal };
  try {
    if (fakeAi()) return await fakePicture(r);
    if (req.model.provider === "openai") return await openaiPicture(r);
    if (req.model.provider === "google") return await googlePicture(r);
    if (req.model.provider === "xai") return await xaiPicture(r);
  } catch (e) {
    if (req.signal.aborted) throw e;
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(pictureError(req.model, e));
  }
  throw new ProviderError(`${req.model.name} can't make pictures.`);
}

/** Why a picture wasn't made, worded for the person asking. */
function pictureError(model: Model, e: unknown): string {
  const name = PROVIDER_NAME[model.provider];
  const said = detail(e);
  const code = status(e);
  if ((e as { name?: string })?.name === "TimeoutError" || /timed? ?out/i.test(said)) {
    return `${model.name} took too long to make the picture. Try again, or try a simpler description.`;
  }
  if (/moderation|safety|content policy|not allowed|rejected by|prohibited/i.test(said)) {
    return `${name}'s safety check turned this picture down. Try describing it differently.`;
  }
  if (model.provider === "google" && (code === 429 || /quota|resource.?exhausted/i.test(said)) && /limit: ?0|free.?tier/i.test(said)) {
    return "Google's picture models don't work on a free key. Your family admin can turn on billing for the key in Google AI Studio, or pick another picture model.";
  }
  if (model.provider === "openai" && code === 403 && /verif/i.test(said)) {
    return `OpenAI asks organisations to verify themselves before using ${model.name}. Your family admin can do that in the OpenAI dashboard (Settings, Organization, General).`;
  }
  return describe(model.provider, e);
}

const openaiQuality = (m: Model): "high" | "medium" => (m.id.includes("sunburst") ? "high" : "medium");

async function openaiPicture({ model, apiKey, prompt, images, signal }: PictureRequest): Promise<PictureResult> {
  const baseURL = (!process.env.VERCEL && process.env.DEPECHE_OPENAI_URL) || undefined;
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 1 });
  const common = {
    model: model.id,
    prompt,
    n: 1,
    size: openaiSize(askedAspect(prompt)) as "auto",
    quality: openaiQuality(model),
    // JPEG keeps pictures small in storage (a third of PNG's size) and opens everywhere.
    output_format: "jpeg" as const,
    output_compression: 92,
  };
  const res = images.length
    ? await client.images.edit(
        {
          ...common,
          image: await Promise.all(images.map((im, i) => toFile(im.data, `picture-${i + 1}.${ext(im.mime)}`, { type: im.mime }))),
        },
        { signal },
      )
    : await client.images.generate(common, { signal });
  const out = (res.data ?? []).flatMap((d) => (d.b64_json ? [{ mime: "image/jpeg", data: Buffer.from(d.b64_json, "base64") }] : []));
  const u = res.usage;
  const usage: ImageUsage | undefined = u
    ? {
        textIn: u.input_tokens_details?.text_tokens ?? u.input_tokens,
        imagesIn: u.input_tokens_details?.image_tokens ?? 0,
        imageOut: u.output_tokens_details?.image_tokens ?? u.output_tokens,
        textOut: u.output_tokens_details?.text_tokens ?? 0,
      }
    : undefined;
  if (!out.length) throw new ProviderError(`${model.name} didn't send a picture back. Try again, or describe it differently.`);
  return { images: out, text: "", usage };
}

async function googlePicture({ model, apiKey, prompt, images, signal }: PictureRequest): Promise<PictureResult> {
  const baseUrl = (!process.env.VERCEL && process.env.DEPECHE_GOOGLE_URL) || undefined;
  const ai = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  const aspect = askedAspect(prompt);
  const parts: Part[] = [...images.map((im) => ({ inlineData: { mimeType: im.mime, data: im.data.toString("base64") } })), { text: prompt }];
  const res = await ai.models.generateContent({
    model: model.id,
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      abortSignal: signal,
      ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}),
    },
  });
  const cand = res.candidates?.[0];
  const out: Picture[] = [];
  let text = "";
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) continue;
    if (p.inlineData?.data) out.push({ mime: p.inlineData.mimeType || "image/png", data: Buffer.from(p.inlineData.data, "base64") });
    else if (p.text) text += p.text;
  }
  const m = res.usageMetadata;
  const imageOut = (m?.candidatesTokensDetails ?? []).filter((d) => d.modality === "IMAGE").reduce((n, d) => n + (d.tokenCount ?? 0), 0);
  const imagesIn = (m?.promptTokensDetails ?? []).filter((d) => d.modality === "IMAGE").reduce((n, d) => n + (d.tokenCount ?? 0), 0);
  const usage: ImageUsage | undefined = m
    ? {
        textIn: Math.max(0, (m.promptTokenCount ?? 0) - imagesIn),
        imagesIn,
        imageOut,
        textOut: Math.max(0, (m.candidatesTokenCount ?? 0) - imageOut) + (m.thoughtsTokenCount ?? 0),
      }
    : undefined;
  if (!out.length) {
    const reason = cand?.finishReason ?? res.promptFeedback?.blockReason;
    if (reason && /SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(String(reason))) {
      throw new ProviderError("Google's safety check turned this picture down. Try describing it differently.");
    }
    // The model sometimes answers in words instead (asking what's wanted, say); that is kept as the reply.
    if (!text.trim()) throw new ProviderError(`${model.name} didn't send a picture back. Try again, or describe it differently.`);
  }
  return { images: out, text: text.trim(), usage };
}

type XaiImages = {
  data?: { b64_json?: string | null; url?: string | null; mime_type?: string | null }[];
  usage?: { cost_in_usd_ticks?: number | null } | null;
  error?: { message?: string } | string;
};

async function xaiPicture({ model, apiKey, prompt, images, signal }: PictureRequest): Promise<PictureResult> {
  const base = (!process.env.VERCEL && process.env.DEPECHE_XAI_URL) || "https://api.x.ai/v1";
  const aspect = askedAspect(prompt);
  const edit = images[0];
  const res = await fetch(`${base}/images/${edit ? "edits" : "generations"}`, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      prompt,
      n: 1,
      response_format: "b64_json",
      ...(aspect ? { aspect_ratio: aspect } : {}),
      ...(edit ? { image: { url: `data:${edit.mime};base64,${edit.data.toString("base64")}`, type: "image_url" } } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as XaiImages;
  if (!res.ok) {
    const msg = typeof body.error === "string" ? body.error : (body.error?.message ?? `HTTP ${res.status}`);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  const out: Picture[] = [];
  for (const d of body.data ?? []) {
    const mime = d.mime_type && EDITABLE.includes(d.mime_type) ? d.mime_type : "image/jpeg";
    if (d.b64_json) out.push({ mime, data: Buffer.from(d.b64_json, "base64") });
    else if (d.url && /^https:\/\//.test(d.url)) {
      // Only ever fetched as a picture to store; never shown from xAI's address.
      const pic = await fetch(d.url, { signal });
      const type = pic.headers.get("content-type")?.split(";")[0] ?? mime;
      if (pic.ok && EDITABLE.includes(type)) out.push({ mime: type, data: Buffer.from(await pic.arrayBuffer()) });
    }
  }
  if (!out.length) throw new ProviderError(`${model.name} didn't send a picture back. Try again, or describe it differently.`);
  // xAI reports what it charged in ticks of a ten-billionth of a dollar.
  const ticks = body.usage?.cost_in_usd_ticks;
  return { images: out, text: "", usage: typeof ticks === "number" ? { textIn: 0, imagesIn: 0, imageOut: 0, textOut: 0, reportedUsd: ticks / 1e10 } : undefined };
}

const ext = (mime: string) => (mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg");

/**
 * The stand-in for tests: a striped picture, with the stripes the other way round when it edits.
 * "refuse" in the description acts like a safety check, and "slowly" takes a moment.
 */
async function fakePicture({ model, prompt, images, signal }: PictureRequest): Promise<PictureResult> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, /slowly/i.test(prompt) ? 2500 : 300);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
  });
  if (/refuse/i.test(prompt)) throw new ProviderError(`${PROVIDER_NAME[model.provider]}'s safety check turned this picture down. Try describing it differently.`);
  const usage: ImageUsage = { textIn: 40, imagesIn: images.length * 500, imageOut: 1100, textOut: 0 };
  return { images: [{ mime: "image/png", data: stripes(images.length > 0) }], text: "", usage };
}

/** A small PNG made without any image library. */
export function stripes(edited: boolean, size = 96): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const on = Math.floor((edited ? y : x) / 12) % 2 === 0;
      raw.fill(on ? 0 : 255, y * (size * 3 + 1) + 1 + x * 3, y * (size * 3 + 1) + 4 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
