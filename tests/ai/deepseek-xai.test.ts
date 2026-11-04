import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MODELS, PROVIDERS, PROVIDER_NAME, canLookUp, canSearch, estimateCost, findModel, modelsFor, searchCost } from "@/lib/ai/models";
import { planReply, MAX_OUTPUT } from "@/lib/ai/budget";

vi.mock("server-only", () => ({}));

const { streamReply, modelsThatMayAnswer, ProviderError } = await import("@/lib/ai/providers");
const { rewriteCites, responseUsage, reportedSearches } = await import("@/lib/ai/xai");
const { completionUsage } = await import("@/lib/ai/deepseek");

/**
 * DeepSeek and xAI are tested against a local stand-in that answers the way each API does, so
 * Depeche's own request building and stream reading run for real.
 */
type Handler = (path: string, body: Record<string, unknown>) => { status?: number; sse?: unknown[]; json?: unknown };
let handler: Handler = () => ({ status: 500, json: { error: { message: "no handler" } } });
const seen: { path: string; body: Record<string, unknown>; auth?: string }[] = [];
let server: Server;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => r(s));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}");
    seen.push({ path: req.url ?? "", body, auth: req.headers.authorization });
    const out = handler(req.url ?? "", body);
    if (out.sse) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const ev of out.sse) {
        const type = (ev as { type?: string }).type;
        res.write(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(ev)}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.stubEnv("DEPECHE_DEEPSEEK_URL", url);
  vi.stubEnv("DEPECHE_XAI_URL", url);
  vi.stubEnv("DEPECHE_FAKE_AI", "0");
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});
afterEach(() => (seen.length = 0));

async function run(model: string, turns: { role: "user" | "assistant"; text: string; files?: { name: string; mime: string; data: string }[] }[], search = false) {
  const events = [];
  for await (const ev of streamReply({
    model: findModel(model)!,
    apiKey: "sk-test",
    system: "Be kind.",
    turns,
    signal: new AbortController().signal,
    search,
    maxOutput: 1000,
  })) events.push(ev);
  return events;
}
const text = (events: { type: string; text?: string }[]) => events.filter((e) => e.type === "text").map((e) => e.text).join("");

describe("providers list", () => {
  it("offers DeepSeek and xAI with their models; only Grok searches", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(expect.arrayContaining(["deepseek", "xai"]));
    expect(modelsFor([{ provider: "deepseek", models: null }]).map((m) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);
    expect(modelsFor([{ provider: "xai", models: null }]).map((m) => m.id)).toEqual(["grok-4.7", "grok-4.3", "grok-imagine-image-2.0"]);
    expect(PROVIDER_NAME.deepseek).toBe("DeepSeek");
    expect(PROVIDER_NAME.xai).toBe("xAI");
    expect(canSearch(findModel("deepseek-v4-pro"))).toBe(false);
    expect(canSearch(findModel("deepseek-flash"))).toBe(false);
    expect(canSearch(findModel("grok-4.7"))).toBe(true);
    expect(searchCost("xai", 2)).toBeCloseTo(0.01);
    // "Search this chat" isn't wired up for them yet, so it is never offered.
    expect(canLookUp("deepseek")).toBe(false);
    expect(canLookUp("xai")).toBe(false);
    expect(canLookUp("anthropic")).toBe(true);
    expect(MODELS.filter((m) => (m.provider === "deepseek" || m.provider === "xai") && !m.image).every((m) => m.price.input > 0 && m.price.output > 0)).toBe(true);
  });

  it("charge Grok's long-context rate once input reaches 200,000 tokens, and hold for it", () => {
    const grok = findModel("grok-4.7")!;
    expect(estimateCost(grok, 100_000, 1000)).toBeCloseTo((100_000 * 2 + 1000 * 6) / 1e6);
    expect(estimateCost(grok, 250_000, 1000)).toBeCloseTo((250_000 * 4 + 1000 * 12) / 1e6);
    const plan = planReply([grok], 250_000);
    expect(estimateCost(grok, 250_000, MAX_OUTPUT)).toBeLessThanOrEqual(plan.want + 1e-9);
    // Search pages can tip a request over the threshold, and the hold counts them.
    expect(planReply([grok], 190_000, { extraInputTokens: 20_000 }).want).toBeGreaterThanOrEqual(estimateCost(grok, 210_000, MAX_OUTPUT));
  });

  it("hold for DeepSeek's thinking on top of the reply, and for Flash answering pictures for Pro", () => {
    const pro = findModel("deepseek-v4-pro")!;
    expect(modelsThatMayAnswer(pro).map((m) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);
    const plan = planReply([pro], 1000);
    expect(plan.want).toBeGreaterThanOrEqual(estimateCost(pro, 1000, MAX_OUTPUT * 2));
  });
});

describe("DeepSeek", () => {
  it("streams the reply, keeps the thinking apart from it, and counts thinking as output", async () => {
    handler = () => ({
      sse: [
        { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Let me think" } }] },
        { choices: [{ index: 0, delta: { content: "Hello " } }] },
        { choices: [{ index: 0, delta: { content: "there." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } },
      ],
    });
    const events = await run("deepseek-v4-pro", [{ role: "user", text: "Hi" }]);
    expect(text(events)).toBe("Hello there.");
    // The thinking is passed on separately, to show collapsed above the reply.
    expect(events.filter((e) => e.type === "thinking")).toEqual([{ type: "thinking", text: "Let me think" }]);
    expect(events.at(-1)).toEqual({ type: "usage", input: 50, output: 30 });
    const req = seen[0];
    expect(req.path).toBe("/chat/completions");
    expect(req.auth).toBe("Bearer sk-test");
    expect(req.body).toMatchObject({ model: "deepseek-v4-pro", stream: true, max_tokens: 1000 });
    expect(req.body.tools).toBeUndefined();
    expect((req.body.messages as { role: string }[])[0]).toEqual({ role: "system", content: "Be kind." });
  });

  it("never offers search, even when asked", async () => {
    handler = () => ({ sse: [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }] });
    const events = await run("deepseek-flash", [{ role: "user", text: "latest news" }], true);
    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(JSON.stringify(seen[0].body)).not.toContain("search");
  });

  it("sends pictures to Flash, saying so when Pro was picked", async () => {
    handler = () => ({ sse: [{ choices: [{ index: 0, delta: { content: "A cat." }, finish_reason: "stop" }] }] });
    const events = await run("deepseek-v4-pro", [{ role: "user", text: "What is it?", files: [{ name: "cat.png", mime: "image/png", data: "iVBORw0KGgo=" }] }]);
    expect(events).toContainEqual({ type: "model", id: "deepseek-flash" });
    expect(events).toContainEqual({ type: "notice", text: "DeepSeek V4 Pro can't see pictures, so DeepSeek V4.1 Flash answered instead." });
    expect(seen[0].body.model).toBe("deepseek-flash");
    const content = (seen[0].body.messages as { content: unknown }[])[1].content;
    expect(content).toEqual([
      { type: "text", text: "What is it?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
  });

  it("says plainly when the key is out of credit", async () => {
    handler = () => ({ status: 402, json: { error: { message: "Insufficient Balance", type: "unknown_error" } } });
    const err = await run("deepseek-flash", [{ role: "user", text: "Hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("DeepSeek says your family's key is out of credit.");
    expect(err.message).toContain('DeepSeek said: "');
  });

  it("lets the other model answer when DeepSeek's servers are busy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    handler = (_path, body) =>
      body.model === "deepseek-v4-pro"
        ? { status: 503, json: { error: { message: "Server overloaded, please try again later" } } }
        : { sse: [{ choices: [{ index: 0, delta: { content: "Flash here." }, finish_reason: "stop" }] }] };
    const events = await run("deepseek-v4-pro", [{ role: "user", text: "Hi" }]);
    vi.useRealTimers();
    expect(events).toContainEqual({ type: "notice", text: "DeepSeek V4 Pro was busy, so DeepSeek V4.1 Flash answered instead." });
    expect(text(events)).toBe("Flash here.");
  }, 20_000);

  it("counts thinking whichever way usage reports it", () => {
    expect(completionUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 40 })).toEqual({ input: 10, output: 30 });
    expect(completionUsage({ prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 })).toEqual({ input: 10, output: 30 });
  });
});

describe("xAI Grok", () => {
  const done = (extra: Record<string, unknown>) => ({ type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020 }, ...extra } });

  it("streams a reply through the Responses API without storing it", async () => {
    handler = () => ({
      sse: [
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_text.delta", delta: "Hi " },
        { type: "response.output_text.delta", delta: "Hasan." },
        done({}),
      ],
    });
    const events = await run("grok-4.3", [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hey" }, { role: "user", text: "Again" }]);
    expect(text(events)).toBe("Hi Hasan.");
    expect(events.at(-1)).toEqual({ type: "usage", input: 900, output: 120 });
    expect(seen[0].path).toBe("/responses");
    expect(seen[0].body).toMatchObject({ model: "grok-4.3", store: false, stream: true, max_output_tokens: 1000, instructions: "Be kind." });
    expect(seen[0].body.tools).toBeUndefined();
    expect(seen[0].body.input).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hey" },
      { role: "user", content: "Again" },
    ]);
  });

  it("searches the web, shows sources, counts searches, and turns Grok's citations into numbered links", async () => {
    handler = () => ({
      sse: [
        { type: "response.output_item.added", item: { type: "web_search_call", id: "ws1", status: "in_progress" } },
        { type: "response.output_item.done", item: { type: "web_search_call", id: "ws1", status: "completed", action: { type: "search", query: "depeche news" } } },
        { type: "response.output_text.delta", delta: "It's out now [[" },
        { type: "response.output_text.delta", delta: "1]](https://example.com/a" },
        { type: "response.output_text.delta", delta: ").[[2]](https://example.org/b)" },
        done({
          output: [
            { type: "web_search_call", id: "ws1", action: { type: "search", query: "depeche news" } },
            { type: "message", content: [{ type: "output_text", annotations: [{ type: "url_citation", url: "https://example.com/a", title: "1" }] }] },
          ],
          citations: ["https://example.com/a", "https://example.org/b", "javascript:alert(1)"],
          usage: { input_tokens: 4000, output_tokens: 100, total_tokens: 4300, server_side_tool_usage_details: { web_search_calls: 1 } },
        }),
      ],
    });
    const events = await run("grok-4.7", [{ role: "user", text: "Latest?" }], true);
    expect(seen[0].body.tools).toEqual([{ type: "web_search" }]);
    expect(events).toContainEqual({ type: "searching" });
    expect(events).toContainEqual({ type: "searching", query: "depeche news" });
    expect(text(events)).toBe("It's out now [1](https://example.com/a). [2](https://example.org/b)");
    expect(events).toContainEqual({
      type: "sources",
      sources: [
        { url: "https://example.com/a", title: "example.com" },
        { url: "https://example.org/b", title: "example.org" },
      ],
    });
    expect(events).toContainEqual({ type: "searches", count: 1 });
    // Reasoning reported outside output_tokens is still counted.
    expect(events.at(-1)).toEqual({ type: "usage", input: 4000, output: 300 });
  });

  it("answers without search, and says so, if search is refused", async () => {
    handler = (_p, body) =>
      body.tools
        ? { status: 400, json: { error: { message: "web_search is not supported for this model" } } }
        : { sse: [{ type: "response.output_text.delta", delta: "From memory." }, done({})] };
    const events = await run("grok-4.3", [{ role: "user", text: "Latest?" }], true);
    expect(text(events)).toBe("From memory.");
    expect(events.find((e) => e.type === "notice")).toMatchObject({ text: expect.stringContaining("Web search wasn't available") });
  });

  it("sends JPEG and PNG pictures, and PDFs that can't be read are named", async () => {
    handler = () => ({ sse: [{ type: "response.output_text.delta", delta: "Seen." }, done({})] });
    await run("grok-4.7", [
      {
        role: "user",
        text: "Look",
        files: [
          { name: "a.png", mime: "image/png", data: "AAAA" },
          { name: "b.webp", mime: "image/webp", data: "BBBB" },
          { name: "c.pdf", mime: "application/pdf", data: "bm90IGEgcGRm" },
        ],
      },
    ]);
    const [msg] = seen[0].body.input as { content: { type: string; text?: string; image_url?: string }[] }[];
    expect(msg.content[0]).toEqual({ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" });
    expect(msg.content[1].type).toBe("input_text");
    expect(msg.content[1].text).toContain("[Attached picture b.webp, not sent to this model (Grok takes JPEG and PNG only).]");
    expect(msg.content[1].text).toContain("[Attached c.pdf: no text could be read from this PDF.]");
  });

  it("says plainly when the team has no credits, and when the key is wrong", async () => {
    handler = () => ({ status: 403, json: { code: "forbidden", error: "Your newly created team doesn't have any credits yet." } });
    let err = await run("grok-4.7", [{ role: "user", text: "Hi" }]).catch((e) => e);
    expect(err.message).toContain("xAI says your family's key is out of credit.");
    handler = () => ({ status: 400, json: { code: "Client specified an invalid argument", error: "Incorrect API key provided: xa***yz." } });
    err = await run("grok-4.7", [{ role: "user", text: "Hi" }]).catch((e) => e);
    expect(err.message).toContain("xAI didn't accept your family's key.");
  });

  it("rewrites citations even when split mid-link, and leaves ordinary brackets alone", () => {
    expect(rewriteCites("See [[3]](https://a.io/x) and [this](https://b.io)")).toEqual({ out: "See [3](https://a.io/x) and [this](https://b.io)", rest: "" });
    expect(rewriteCites("Done [[1]](https://a.io/")).toEqual({ out: "Done", rest: " [[1]](https://a.io/" });
    expect(rewriteCites("x [")).toEqual({ out: "x", rest: " [" });
    expect(rewriteCites("array[0] is [fine]")).toEqual({ out: "array[0] is [fine]", rest: "" });
  });

  it("reads usage and search counts from whichever field xAI fills", () => {
    expect(responseUsage({ input_tokens: 5, output_tokens: 9, total_tokens: 14 })).toEqual({ input: 5, output: 9 });
    expect(reportedSearches({ server_side_tool_usage: { SERVER_SIDE_TOOL_WEB_SEARCH: 3 } })).toBe(3);
    expect(reportedSearches({})).toBe(0);
  });
});
