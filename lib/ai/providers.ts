import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { Model, Provider } from "@/lib/ai/models";

/**
 * One streaming interface over the three providers. Depeche stores conversations in its own
 * provider-neutral shape and turns them into each provider's format here, so a chat can switch
 * models halfway through.
 */
export type Turn = { role: "user" | "assistant"; text: string };

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "usage"; input: number; output: number }
  | { type: "notice"; text: string };

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

export async function* streamReply(req: ReplyRequest): AsyncGenerator<StreamEvent> {
  if (fakeAi()) {
    yield* fakeReply(req);
    return;
  }
  try {
    if (req.model.provider === "anthropic") yield* anthropicReply(req);
    else if (req.model.provider === "openai") yield* openaiReply(req);
    else yield* googleReply(req);
  } catch (e) {
    if (req.signal.aborted) throw e;
    throw new ProviderError(describe(req.model.provider, e));
  }
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

function describe(provider: Provider, e: unknown): string {
  const name = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" }[provider];
  const code = status(e);
  const msg = e instanceof Error ? e.message : "";
  if (code === 401 || code === 403 || /api key|unauthori[sz]ed|permission/i.test(msg))
    return `${name} didn't accept your family's key. Ask your family admin to check it in Family settings.`;
  if (provider === "google" && (code === 429 || /quota|rate limit|resource.?exhausted/i.test(msg)))
    return "Google's limit for this key is reached for now. Free keys allow only a few messages a minute and some models not at all. Wait a minute, or pick a Flash model.";
  if (code === 429 || /quota|rate limit|credit|billing/i.test(msg))
    return `${name} says the key is out of credit or busy. Try again in a minute, or ask your family admin to check billing.`;
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

async function* fakeReply({ turns, signal }: ReplyRequest): AsyncGenerator<StreamEvent> {
  const q = turns.at(-1)?.text.slice(0, 80) ?? "";
  const reply = FAKE_REPLY.replace("{q}", q);
  const slow = q.includes("slowly");
  for (let i = 0; i < reply.length; i += 24) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, slow ? 120 : 8));
    yield { type: "text", text: reply.slice(i, i + 24) };
  }
  yield { type: "usage", input: 1200, output: 400 };
}
