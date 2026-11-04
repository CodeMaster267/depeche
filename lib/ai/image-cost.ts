import { inputTokensUpperBound } from "@/lib/ai/budget";
import type { Model } from "@/lib/ai/models";

/**
 * Spending for picture models. Before a picture is made, the most it could cost is reserved
 * against the person's monthly limit (the same hold as for replies); afterwards the hold is swapped
 * for what the provider reports, or for the estimate when it reports nothing.
 */

/** The most pictures one message can send to be edited. xAI takes only one. */
export const MAX_IMAGES_IN = 5;

/** The most one picture request could cost, in dollars. */
export function imageHold(model: Model, prompt: string, picturesIn: number): number {
  const p = model.image;
  if (!p) throw new Error(`${model.id} doesn't make pictures`);
  const text = (inputTokensUpperBound([prompt]) * model.price.input) / 1_000_000;
  return p.hold + Math.min(picturesIn, MAX_IMAGES_IN) * p.perInput + text;
}

/** Token counts as the providers report them, split by what they were. */
export type ImageUsage = {
  textIn: number;
  imagesIn: number;
  /** Picture tokens made (OpenAI, Google). */
  imageOut: number;
  /** Thinking and words written alongside the picture. */
  textOut: number;
  /** What the provider said it charged, when it says (xAI). */
  reportedUsd?: number;
};

/** What a request cost, in dollars, erring high. */
export function imageCost(model: Model, usage: ImageUsage | undefined, picturesIn: number, picturesOut: number): number {
  const p = model.image;
  if (!p) return 0;
  if (p.flat !== undefined) {
    // Billed per picture. Where the provider reports its charge, the larger of the two is used.
    const estimate = picturesOut * p.flat + Math.min(picturesIn, MAX_IMAGES_IN) * p.perInput;
    const reported = usage?.reportedUsd;
    return reported !== undefined && Number.isFinite(reported) && reported >= 0 && reported < 5 ? Math.max(estimate, reported) : estimate;
  }
  // No report (stopped, or the provider left it out): count the reserved amount for each picture.
  if (!usage) return picturesOut ? picturesOut * p.hold + Math.min(picturesIn, MAX_IMAGES_IN) * p.perInput : 0;
  const perM =
    usage.textIn * model.price.input +
    usage.imagesIn * (p.imageInput ?? model.price.input) +
    usage.imageOut * model.price.output +
    usage.textOut * (p.textOutput ?? model.price.output);
  return Math.max(0, perM / 1_000_000);
}

/** An aspect ratio the person typed ("16:9", "9:16"), if a provider supports it. */
export function askedAspect(prompt: string): string | undefined {
  const RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
  const m = /\b(\d{1,2})\s*[:x×]\s*(\d{1,2})\b/.exec(prompt);
  const r = m ? `${Number(m[1])}:${Number(m[2])}` : undefined;
  return r && RATIOS.includes(r) ? r : undefined;
}

/** OpenAI takes sizes rather than ratios; it picks one itself when none is asked for. */
export function openaiSize(aspect: string | undefined): string {
  if (!aspect) return "auto";
  const [w, h] = aspect.split(":").map(Number);
  if (w === h) return "1024x1024";
  // About a million pixels, each side a multiple of 16, as GPT Image 2.5 accepts.
  const scale = Math.sqrt((1024 * 1024) / (w * h));
  const side = (n: number) => Math.max(256, Math.round((n * scale) / 16) * 16);
  return `${side(w)}x${side(h)}`;
}

/** A short file name for a picture, from what was asked for. */
export function pictureName(prompt: string, mime: string, index = 0): string {
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const words = prompt
    .normalize("NFKD")
    .replace(/[^\w\s-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${words || "Picture"}${index ? `-${index + 1}` : ""}.${ext}`;
}
