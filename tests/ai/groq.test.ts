import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODELS, PROVIDERS, canSearch, findModel, modelsFor, searchCost } from "@/lib/ai/models";

vi.mock("server-only", () => ({}));

const { streamReply, ProviderError } = await import("@/lib/ai/providers");
const { groqTool, stripGroqMarks, fitMessages, groqMessages, estimateTokens } = await import("@/lib/ai/groq");

async function run(model: string, text: string, search = true) {
  const events = [];
  for await (const ev of streamReply({
    model: findModel(model)!,
    apiKey: "test-key",
    system: "",
    turns: [{ role: "user", text }],
    signal: new AbortController().signal,
    search,
  })) events.push(ev);
  return events;
}

describe("Groq", () => {
  beforeAll(() => vi.stubEnv("DEPECHE_FAKE_AI", "1"));
  afterAll(() => vi.unstubAllEnvs());

  it("is a provider with its free-tier models, of which GPT-OSS can search", () => {
    expect(PROVIDERS.map((p) => p.id)).toContain("groq");
    expect(modelsFor([{ provider: "groq", models: null }]).map((m) => m.id)).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b",
    ]);
    expect(MODELS.filter((m) => m.provider === "groq").every((m) => m.price.input > 0)).toBe(true);
    expect(canSearch(findModel("openai/gpt-oss-120b"))).toBe(true);
    expect(canSearch(findModel("openai/gpt-oss-20b"))).toBe(true);
    expect(canSearch(findModel("qwen/qwen3.8-27b"))).toBe(false);
    expect(canSearch(findModel("gemini-3.8-flash"))).toBe(true);
    expect(searchCost("groq", 3)).toBeCloseTo(0.015);
  });

  it("GPT-OSS searches when asked; Qwen answers without searching", async () => {
    const searched = await run("openai/gpt-oss-120b", "latest news");
    expect(searched.some((e) => e.type === "sources")).toBe(true);
    const plain = await run("qwen/qwen3.8-27b", "latest news");
    expect(plain.some((e) => e.type === "searching" || e.type === "sources")).toBe(false);
    expect(plain.at(-1)?.type).toBe("usage");
  });

  it("drops Groq's citation marks, even when one is split across chunks", () => {
    expect(stripGroqMarks("Paris is the capital【0†L3-L5】.")).toEqual({ out: "Paris is the capital.", rest: "" });
    const first = stripGroqMarks("It rained【2†L");
    expect(first).toEqual({ out: "It rained", rest: "【2†L" });
    expect(stripGroqMarks(first.rest + "1-L4】 today.")).toEqual({ out: " today.", rest: "" });
    expect(stripGroqMarks("a 【 bracket that never closes " + "x".repeat(50))).toEqual({
      out: "a 【 bracket that never closes " + "x".repeat(50),
      rest: "",
    });
  });

  it("reads browser searches and their pages, counting each search once", () => {
    const seen = new Set<string>();
    const sources: { url: string; title: string }[] = [];
    const tool = {
      index: 0,
      type: "search",
      arguments: '{"query":"weather in Paris"}',
      search_results: { results: [{ title: "Météo", url: "https://meteo.fr/paris" }, { title: "bad", url: "javascript:alert(1)" }] },
    };
    expect(groqTool(tool, seen, sources)).toEqual({ searched: true, query: "weather in Paris" });
    expect(groqTool(tool, seen, sources)).toEqual({ searched: false });
    expect(groqTool({ index: 1, type: "open", arguments: '{"id":3}' }, seen, sources).searched).toBe(false);
    expect(sources).toEqual([{ url: "https://meteo.fr/paris", title: "Météo" }]);
  });

  it("lets the sibling model answer when one model's free-tier limit is reached", async () => {
    const events = await run("openai/gpt-oss-120b", "ratelimit please");
    expect(events[0]).toEqual({ type: "model", id: "openai/gpt-oss-20b" });
    expect(events[1]).toEqual({
      type: "notice",
      text: "GPT-OSS 120B (Groq) reached its free-tier limit, so GPT-OSS 20B (Groq) answered instead.",
    });
    expect(events.some((e) => e.type === "text")).toBe(true);
  });

  it("says plainly when the limit is reached on both, with Groq's own words", async () => {
    const started = Date.now();
    const error = await run("openai/gpt-oss-20b", "ratelimitall").catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/^Groq's free tier allows only so much a minute, and that's used up\. Try again in 3 seconds\./);
    expect(error.message).toContain('(Groq said: "Rate limit reached for model');
    // A used-up allowance isn't retried with pauses like a busy server.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/** A one-page PDF that says "Hello from a PDF". pdf.js rebuilds the missing cross-reference table. */
const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 50 Td (Hello from a PDF) Tj ET\nendstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
).toString("base64");

describe("Groq uploads on the free tier", () => {
  it("reads a PDF's text, sends pictures only to Qwen, and names what it couldn't send", async () => {
    const png = { name: "cat.png", mime: "image/png", data: "iVBORw0KGgo=" };
    const turns = [{ role: "user" as const, text: "What's this?", files: [{ name: "doc.pdf", mime: "application/pdf", data: TINY_PDF }, png] }];
    const qwen = await groqMessages("sys", turns, true);
    const parts = qwen.messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0].text).toContain('<file name="doc.pdf">');
    expect(parts[0].text).toContain("Hello from a PDF");
    expect(parts[1].image_url?.url).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(qwen.skipped).toBeUndefined();

    const tooMany = await groqMessages("sys", [{ role: "user", text: "", files: [png, png, png, { ...png, name: "four.png" }] }], true);
    expect((tooMany.messages[1].content as unknown[]).length).toBe(4);
    expect(tooMany.skipped).toMatch(/four\.png wasn't sent/);
  });

  it("fits a long chat and a long file into the free tier's allowance", () => {
    const long = "word ".repeat(20_000);
    const messages = [
      { role: "system" as const, content: "Be helpful." },
      { role: "user" as const, content: "old question " + long },
      { role: "assistant" as const, content: "old answer" },
      { role: "user" as const, content: "short question" },
      { role: "assistant" as const, content: "short answer" },
      { role: "user" as const, content: `<file name="big.txt">${long}</file>` },
    ];
    const fitted = fitMessages(messages, 4200);
    const total = fitted.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    expect(total).toBeLessThanOrEqual(4200);
    expect(fitted.messages[0].content).toBe("Be helpful.");
    expect(fitted.messages[1].role).toBe("user");
    expect(String(fitted.messages.at(-1)?.content)).toContain("[The rest was cut to fit Groq's free tier.]");
    expect(fitted.note).toMatch(/earlier messages? (was|were) left out and your message or file was shortened/);

    const small = fitMessages(messages.slice(0, 1).concat(messages.slice(3, 5), [{ role: "user", content: "hi" }]), 4200);
    expect(small.messages).toHaveLength(4);
    expect(small.note).toBe("nothing was left out");
  });
});

describe("Groq's too-large error", () => {
  it("sends the request again, cut to fit, and says what was left out", async () => {
    const { createServer } = await import("node:http");
    const bodies: { messages: { content: unknown }[]; max_completion_tokens?: number }[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        if (bodies.length === 1) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Request too large for model `qwen/qwen3.8-27b` on input tokens per minute (ITPM): Limit 7000, Requested 29369, please reduce your message size and try again." } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        chunk({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "Short answer." }, finish_reason: null }] });
        chunk({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3000, completion_tokens: 4 } });
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    vi.stubEnv("DEPECHE_FAKE_AI", "0");
    vi.stubEnv("DEPECHE_GROQ_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
      const long = "word ".repeat(30_000);
      const events = [];
      for await (const ev of streamReply({
        model: findModel("qwen/qwen3.8-27b")!,
        apiKey: "gsk_test",
        system: "sys",
        turns: [
          { role: "user", text: long },
          { role: "assistant", text: "ok" },
          { role: "user", text: "Summarise", files: [{ name: "doc.pdf", mime: "application/pdf", data: TINY_PDF }] },
        ],
        signal: new AbortController().signal,
      })) events.push(ev);
      expect(bodies).toHaveLength(2);
      const sent = JSON.stringify(bodies[1].messages);
      expect(sent).toContain("Hello from a PDF");
      expect(sent).not.toContain("word word");
      expect(bodies[1].max_completion_tokens).toBe(2450);
      expect(events).toContainEqual({
        type: "notice",
        text: "Groq's free tier takes only about 7,000 tokens a minute, so 2 earlier messages were left out. Pick another provider's model for long chats and files.",
      });
      expect(events).toContainEqual({ type: "text", text: "Short answer." });
      expect(events.at(-1)).toEqual({ type: "usage", input: 3000, output: 4 });
    } finally {
      vi.unstubAllEnvs();
      server.close();
    }
  });
});
