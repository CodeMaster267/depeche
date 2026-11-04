import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MODELS, estimateCost, findModel } from "@/lib/ai/models";
import { MAX_OUTPUT, planReply } from "@/lib/ai/budget";

vi.mock("server-only", () => ({}));

const { streamReply } = await import("@/lib/ai/providers");

/**
 * Prompt caching: Claude is asked to cache each chat, the other providers cache by themselves, and
 * every provider's report of cached input is read and priced. Each provider is a local stand-in
 * that answers the way its API does, so Depeche's own request building and stream reading run.
 */
type Reply = { status?: number; body: string; type: string };
let handler: (path: string, body: Record<string, unknown>) => Reply = () => ({ status: 500, body: "{}", type: "application/json" });
const seen: { path: string; body: Record<string, unknown> }[] = [];
let server: Server;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => r(s));
  });
}

/** Server-sent events, named by their `type` like Anthropic's and OpenAI's. */
function sse(events: object[], done = false): Reply {
  const body = events
    .map((ev) => {
      const type = (ev as { type?: string }).type;
      return `${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(ev)}\n\n`;
    })
    .join("");
  return { body: body + (done ? "data: [DONE]\n\n" : ""), type: "text/event-stream" };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    seen.push({ path: req.url ?? "", body });
    const out = handler(req.url ?? "", body);
    res.writeHead(out.status ?? 200, { "content-type": out.type });
    res.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("DEPECHE_ANTHROPIC_URL", url);
  vi.stubEnv("DEPECHE_OPENAI_URL", url);
  vi.stubEnv("DEPECHE_GOOGLE_URL", url);
  vi.stubEnv("DEPECHE_DEEPSEEK_URL", url);
  vi.stubEnv("DEPECHE_XAI_URL", url);
  vi.stubEnv("DEPECHE_FAKE_AI", "0");
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});
afterEach(() => (seen.length = 0));

async function run(model: string, cacheKey?: string) {
  const events = [];
  for await (const ev of streamReply({
    model: findModel(model)!,
    apiKey: "sk-test",
    system: "Be kind.",
    turns: [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello!" },
      { role: "user", text: "How are you?" },
    ],
    signal: new AbortController().signal,
    maxOutput: 1000,
    cacheKey,
  })) events.push(ev);
  return events;
}

const claudeStream = (usage: Record<string, number>) =>
  sse([
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fine, thanks." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ]);

describe("Claude", () => {
  it("asks Claude to cache the chat, and reports what was read and written", async () => {
    handler = () => claudeStream({ input_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 });
    const events = await run("claude-sonnet-5-5", "chat-1");
    expect(seen[0].path).toMatch(/^\/v1\/messages/);
    expect(seen[0].body.cache_control).toEqual({ type: "ephemeral" });
    expect(events.at(-1)).toEqual({ type: "usage", input: 9320, output: 40, cacheRead: 9000, cacheWrite: 300 });
  });

  it("doesn't cache a one-off request (no cache key), which would only pay the write fee", async () => {
    handler = () => claudeStream({ input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    const events = await run("claude-haiku-5-5");
    expect(seen[0].body.cache_control).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "usage", input: 500, output: 40, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("OpenAI", () => {
  it("sends the chat's cache key and reads cached and written input", async () => {
    handler = () =>
      sse([
        { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "Fine." },
        {
          type: "response.completed",
          response: {
            id: "r",
            output: [],
            usage: { input_tokens: 5000, output_tokens: 30, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 900 }, output_tokens_details: { reasoning_tokens: 0 } },
          },
        },
      ]);
    const events = await run("gpt-6.1-sol", "chat-1");
    expect(seen[0].path).toBe("/responses");
    expect(seen[0].body.prompt_cache_key).toBe("chat-1");
    expect(events.at(-1)).toEqual({ type: "usage", input: 5000, output: 30, cacheRead: 4000, cacheWrite: 900 });
  });
});

describe("Gemini", () => {
  it("reads how much of the prompt Gemini's own cache served", async () => {
    handler = () =>
      sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Fine." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 6000, cachedContentTokenCount: 5000, candidatesTokenCount: 10, thoughtsTokenCount: 5 } },
      ]);
    const events = await run("gemini-3.8-flash", "chat-1");
    expect(seen[0].path).toMatch(/gemini-3\.8-flash:streamGenerateContent/);
    expect(events.at(-1)).toEqual({ type: "usage", input: 6000, output: 15, cacheRead: 5000 });
  });
});

describe("DeepSeek and Grok", () => {
  it("reads DeepSeek's cache hits", async () => {
    handler = () =>
      sse(
        [
          { choices: [{ index: 0, delta: { content: "Fine." }, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 3000, completion_tokens: 20, total_tokens: 3020, prompt_cache_hit_tokens: 2800, prompt_cache_miss_tokens: 200 } },
        ],
        true,
      );
    const events = await run("deepseek-v4-pro", "chat-1");
    expect(events.at(-1)).toEqual({ type: "usage", input: 3000, output: 20, cacheRead: 2800 });
  });

  it("sends Grok the chat's cache key and reads its cached input", async () => {
    handler = () =>
      sse([
        { type: "response.output_text.delta", delta: "Fine." },
        { type: "response.completed", response: { output: [], usage: { input_tokens: 4000, output_tokens: 25, total_tokens: 4025, input_tokens_details: { cached_tokens: 3500 } } } },
      ]);
    const events = await run("grok-4.7", "chat-1");
    expect(seen[0].body.prompt_cache_key).toBe("chat-1");
    expect(events.at(-1)).toEqual({ type: "usage", input: 4000, output: 25, cacheRead: 3500 });
  });
});

describe("pricing cached input", () => {
  it("charges cache reads and writes at each provider's rate", () => {
    const sonnet = findModel("claude-sonnet-5-5")!;
    // 9,000 read at $0.20, 300 written at $2.50, 20 plain at $2, 40 out at $10 (per million).
    expect(estimateCost(sonnet, 9320, 40, { read: 9000, write: 300 })).toBeCloseTo((9000 * 0.2 + 300 * 2.5 + 20 * 2 + 40 * 10) / 1e6, 12);
    expect(estimateCost(findModel("claude-opus-5-5")!, 1e6, 0, { read: 1e6 })).toBeCloseTo(0.2);
    expect(estimateCost(findModel("claude-fable-5-1")!, 1e6, 0, { read: 1e6 })).toBeCloseTo(0.25);
    expect(estimateCost(findModel("gpt-6.1-sol")!, 1e6, 0, { read: 1e6 })).toBeCloseTo(0.1);
    expect(estimateCost(findModel("gpt-6-astra")!, 1e6, 0, { write: 1e6 })).toBeCloseTo(12.5);
    expect(estimateCost(findModel("deepseek-v4-pro")!, 1e6, 0, { read: 1e6 })).toBeCloseTo(0.044);
    expect(estimateCost(findModel("grok-4.7")!, 1e6, 0, { read: 1e6 })).toBeCloseTo(0.5 * 2);
    // Without a report, all input is charged in full, as before.
    expect(estimateCost(sonnet, 1000, 0)).toBeCloseTo(0.002);
  });

  it("never counts more cached input than there was input", () => {
    const sonnet = findModel("claude-sonnet-5-5")!;
    expect(estimateCost(sonnet, 100, 0, { read: 500, write: 500 })).toBeCloseTo((100 * 0.2) / 1e6, 12);
    expect(estimateCost(sonnet, 100, 0, { read: -5 })).toBeCloseTo((100 * 2) / 1e6, 12);
  });

  it("holds enough for every input token to be a cache write", () => {
    for (const m of MODELS) {
      const plan = planReply([m], 50_000);
      expect(estimateCost(m, 50_000, MAX_OUTPUT, { write: 50_000 })).toBeLessThanOrEqual(plan.want + 1e-9);
    }
  });

  it("charges Haiku 5.5's higher rate past 100,000 input tokens", () => {
    const haiku = findModel("claude-haiku-5-5")!;
    expect(estimateCost(haiku, 50_000, 0)).toBeCloseTo(0.005);
    expect(estimateCost(haiku, 150_000, 0)).toBeCloseTo(0.075);
  });
});
