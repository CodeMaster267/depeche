import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { findModel, type Model, type Provider } from "@/lib/ai/models";

/**
 * One streaming interface over the three providers. Depeche stores conversations in its own
 * provider-neutral shape and turns them into each provider's format here, so a chat can switch
 * models halfway through.
 */
export type Turn = { role: "user" | "assistant"; text: string };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; input: number; output: number }
  | { type: "notice"; text: string }
  /** Another model answered (the chosen one was busy). */
  | { type: "model"; id: string };

export type ReplyRequest = {
  model: Model;
  apiKey: string;
  system: string;
  turns: Turn[];
  signal: AbortSignal;
};

/** A provider error, worded for the person chatting. */
export class ProviderError extends Error {}

const MAX_OUTPUT = 32_000;

/**
 * When a model is overloaded (Google's free tier often says "high demand"), try again twice, then
 * let a lighter model from the same provider answer instead and say so.
 */
const BUSY_FALLBACK: Record<string, string> = {
  "gemini-3.8-flash": "gemini-3.5-flash-lite",
  "gemini-4-argon": "gemini-3.8-flash",
  "gemini-3.5-flash-lite": "gemini-3.8-flash",
};

export function isBusy(e: unknown): boolean {
  const code = status(e);
  return code === 500 || code === 502 || code === 503 || code === 504 || code === 529 || /overloaded|high demand|unavailable|try again later/i.test(detail(e));
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export async function* streamReply(req: ReplyRequest): AsyncGenerator<StreamEvent> {
  const attempts: { model: Model; wait: number }[] = [
    { model: req.model, wait: 0 },
    { model: req.model, wait: 1500 },
    { model: req.model, wait: 3500 },
  ];
  const backup = findModel(BUSY_FALLBACK[req.model.id]);
  if (backup) attempts.push({ model: backup, wait: 0 });

  let lastError: unknown;
  for (const attempt of attempts) {
    if (attempt.wait) await pause(attempt.wait, req.signal);
    if (req.signal.aborted) throw new DOMException("Aborted", "AbortError");
    let wrote = false;
    try {
      if (attempt.model.id !== req.model.id) {
        yield { type: "model", id: attempt.model.id };
        yield { type: "notice", text: `${req.model.name} was busy, so ${attempt.model.name} answered instead.` };
      }
      const r = { ...req, model: attempt.model };
      const inner = fakeAi()
        ? fakeReply(r, attempt.model.id === req.model.id)
        : r.model.provider === "anthropic" ? anthropicReply(r) : r.model.provider === "openai" ? openaiReply(r) : googleReply(r);
      for await (const ev of inner) {
        if (ev.type === "text") wrote = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (req.signal.aborted) throw e;
      lastError = e;
      // Retrying after part of a reply was shown would repeat it, and other errors won't go away.
      if (wrote || !isBusy(e)) break;
    }
  }
  throw new ProviderError(describe(req.model.provider, lastError));
}

/** The models that fall back to another Claude model when a safety check declines a request. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);

async function* anthropicReply({ model, apiKey, system, turns, signal }: ReplyRequest): AsyncGenerator<StreamEvent> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const fallback = FALLBACK_MODELS.has(model.id);
  const stream = client.beta.messages.stream(
    {
      model: model.id,
      max_tokens: MAX_OUTPUT,
      system,
      messages: turns.map((t) => ({ role: t.role, content: t.text })),
      output_config: { effort: "medium" },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as never } : {}),
    },
    { signal },
  );
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text", text: ev.delta.text };
  }
  const final = await stream.finalMessage();
  const u = final.usage;
  yield {
    type: "usage",
    input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output: u.output_tokens ?? 0,
  };
  if (final.stop_reason === "refusal") yield { type: "notice", text: "The model declined to answer this." };
  if (final.stop_reason === "max_tokens") yield { type: "notice", text: "The reply hit its length limit." };
}

async function* openaiReply({ model, apiKey, system, turns, signal }: ReplyRequest): AsyncGenerator<StreamEvent> {
  const client = new OpenAI({ apiKey, maxRetries: 1 });
  const stream = await client.responses.create(
    {
      model: model.id,
      instructions: system,
      input: turns.map((t) => ({ role: t.role, content: t.text })),
      max_output_tokens: MAX_OUTPUT,
      store: false,
      stream: true,
    },
    { signal },
  );
  for await (const ev of stream) {
    if (ev.type === "response.output_text.delta") yield { type: "text", text: ev.delta };
    else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
      const u = ev.response.usage;
      yield { type: "usage", input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0 };
      if (ev.type === "response.incomplete") yield { type: "notice", text: "The reply was cut short." };
    } else if (ev.type === "response.failed") {
      throw new Error(ev.response.error?.message ?? "failed");
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
}

async function* googleReply({ model, apiKey, system, turns, signal }: ReplyRequest): AsyncGenerator<StreamEvent> {
  const ai = new GoogleGenAI({ apiKey });
  const stream = await ai.models.generateContentStream({
    model: model.id,
    contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
    config: { systemInstruction: system, maxOutputTokens: MAX_OUTPUT, abortSignal: signal },
  });
  let input = 0;
  let output = 0;
  for await (const chunk of stream) {
    const text = chunk.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    if (text) yield { type: "text", text };
    const u = chunk.usageMetadata;
    if (u) {
      input = u.promptTokenCount ?? input;
      output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || output;
    }
  }
  yield { type: "usage", input, output };
}

function status(e: unknown): number | undefined {
  const s = (e as { status?: unknown; code?: unknown })?.status ?? (e as { code?: unknown })?.code;
  return typeof s === "number" ? s : undefined;
}

/** The provider's own explanation, unwrapped from the JSON some SDKs nest it in. */
function detail(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e ?? "");
  for (let i = 0; i < 3; i++) {
    try {
      const parsed = JSON.parse(msg.slice(msg.indexOf("{"))) as { error?: { message?: string }; message?: string };
      const inner = parsed.error?.message ?? parsed.message;
      if (typeof inner !== "string" || inner === msg) break;
      msg = inner;
    } catch {
      break;
    }
  }
  const cause = (e as { cause?: unknown })?.cause;
  if (cause instanceof Error && !msg.includes(cause.message)) msg += ` (${cause.message})`;
  return msg.replace(/\s+/g, " ").trim().slice(0, 240);
}

function describe(provider: Provider, e: unknown): string {
  const text = friendlyError(provider, e);
  const said = detail(e);
  // Logged for debugging in Vercel; never includes the key.
  console.error(`[chat] ${provider} error`, status(e), said);
  const name = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" }[provider];
  return said ? `${text} (${name} said: "${said}")` : text;
}

function friendlyError(provider: Provider, e: unknown): string {
  const name = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" }[provider];
  const code = status(e);
  const msg = detail(e);
  if (code === 401 || code === 403 || /api key|unauthori[sz]ed|permission/i.test(msg))
    return `${name} didn't accept your family's key. Ask your family admin to check it in Family settings.`;
  if (provider === "google" && (code === 429 || /quota|rate limit|resource.?exhausted/i.test(msg)))
    return "Google's limit for this key is reached for now. Free keys allow only a few messages a minute and some models not at all. Wait a minute, or pick a Flash model.";
  if (code === 429 || /quota|rate limit|credit|billing/i.test(msg))
    return `${name} says the key is out of credit or busy. Try again in a minute, or ask your family admin to check billing.`;
  if (isBusy(e)) return `${name}'s servers are very busy right now, even after a few tries. Wait a minute, or pick another model.`;
  if (code === 404) return `${name} doesn't offer this model to your family's key. Try another model.`;
  if (code === 400) return `${name} couldn't take this request. Try a shorter message or another model.`;
  return `${name} had a problem answering. Try again.`;
}

/** Checks a key with a free request (listing models) before it is saved. */
export async function checkKey(provider: Provider, key: string): Promise<boolean> {
  if (fakeAi()) return key.startsWith("test-");
  const opts = { signal: AbortSignal.timeout(10_000) };
  try {
    const res =
      provider === "anthropic"
        ? await fetch("https://api.anthropic.com/v1/models?limit=1", {
            ...opts,
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          })
        : provider === "openai"
          ? await fetch("https://api.openai.com/v1/models", { ...opts, headers: { authorization: `Bearer ${key}` } })
          : await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
              ...opts,
              headers: { "x-goog-api-key": key },
            });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Browser tests run against a stand-in that streams a fixed rich reply, so they never call a real
 * provider or spend money. Only possible on a local machine or in CI, never on Vercel.
 */
export function fakeAi(): boolean {
  return process.env.DEPECHE_FAKE_AI === "1" && !process.env.VERCEL;
}

const FAKE_REPLY = String.raw`Here's a worked answer to "{q}".

## The formula

The quadratic formula solves $ax^2 + bx + c = 0$:

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

| Step | Working | Result |
| --- | --- | --- |
| Discriminant | $(-7)^2 - 4(2)(3)$ | 25 |
| Roots | $(7 \pm 5)/4$ | 3 and 0.5 |

\`\`\`python
import math

def solve(a, b, c):
    d = b**2 - 4*a*c
    return [(-b + math.sqrt(d)) / (2*a), (-b - math.sqrt(d)) / (2*a)]
\`\`\`

\`\`\`mermaid
graph TD
  D[Discriminant] -->|positive| T[Two real roots]
  D -->|zero| O[One root]
  D -->|negative| N[No real roots]
\`\`\`

> Check: $2(3)^2 - 7(3) + 3 = 0$.

This is well documented[^1].

[^1]: [Quadratic formula](https://en.wikipedia.org/wiki/Quadratic_formula), Wikipedia.
`.replaceAll("\\`", "`");

async function* fakeReply({ turns, signal }: ReplyRequest, chosen = true): AsyncGenerator<StreamEvent> {
  const q = turns.at(-1)?.text.slice(0, 80) ?? "";
  // "busy" in the message makes the chosen model act overloaded, to test retries and the fallback.
  if (chosen && q.includes("busy")) throw Object.assign(new Error("This model is currently experiencing high demand."), { status: 503 });
  const reply = FAKE_REPLY.replace("{q}", q);
  const slow = q.includes("slowly");
  for (let i = 0; i < reply.length; i += 24) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, slow ? 120 : 8));
    yield { type: "text", text: reply.slice(i, i + 24) };
  }
  yield { type: "usage", input: 1200, output: 400 };
}
