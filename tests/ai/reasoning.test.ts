import { describe, expect, it, vi } from "vitest";
import { findModel } from "@/lib/ai/models";
import { thinkingClock, thoughtFor } from "@/lib/chat/activity";

vi.mock("server-only", () => ({}));

const { streamReply } = await import("@/lib/ai/providers");

describe("thinking time", () => {
  it("is worded briefly", () => {
    expect(thoughtFor(undefined)).toBe("Thought for a moment");
    expect(thoughtFor(400)).toBe("Thought for a moment");
    expect(thoughtFor(12_400)).toBe("Thought for 12s");
    expect(thoughtFor(60_000)).toBe("Thought for 1m");
    expect(thoughtFor(65_200)).toBe("Thought for 1m 5s");
  });

  it("adds up separate spells of thinking and ignores the writing between them", () => {
    let now = 0;
    const clock = thinkingClock(() => now);
    clock.thinking();
    now = 3000;
    clock.thinking(); // still the same spell
    now = 4000;
    clock.stopped();
    now = 9000; // writing or searching
    clock.thinking();
    now = 10_500;
    clock.stopped();
    clock.stopped();
    expect(clock.ms).toBe(5500);
  });
});

/** A local stand-in for Groq that replies with these chunks, recording each request. */
async function groqServer(respond: (body: Record<string, unknown>, n: number) => { status?: number; error?: string; chunks?: object[] }) {
  const { createServer } = await import("node:http");
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const r = respond(body, bodies.length);
      if (r.status) {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: r.error } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of r.chunks ?? []) res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", ...c })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  vi.stubEnv("DEPECHE_FAKE_AI", "0");
  vi.stubEnv("DEPECHE_GROQ_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  return {
    bodies,
    close: () => {
      vi.unstubAllEnvs();
      server.close();
    },
  };
}

async function collect(model: string) {
  const events = [];
  for await (const ev of streamReply({
    model: findModel(model)!,
    apiKey: "gsk_test",
    system: "sys",
    turns: [{ role: "user", text: "Why is the sky blue?" }],
    signal: new AbortController().signal,
  })) events.push(ev);
  return events;
}

const ANSWER = [
  { choices: [{ index: 0, delta: { reasoning: "Rayleigh " }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { reasoning: "scattering." }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: "Blue light scatters most." }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8 } },
];

describe("reasoning from the providers", () => {
  it("asks Groq for reasoning in its own field and passes it on separately from the reply", async () => {
    const groq = await groqServer(() => ({ chunks: ANSWER }));
    try {
      const events = await collect("openai/gpt-oss-120b");
      expect(groq.bodies[0].include_reasoning).toBe(true);
      expect(events.filter((e) => e.type === "thinking")).toEqual([
        { type: "thinking", text: "Rayleigh " },
        { type: "thinking", text: "scattering." },
      ]);
      expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "Blue light scatters most." }]);

      await collect("qwen/qwen3.8-27b");
      expect(groq.bodies[1].reasoning_format).toBe("parsed");
    } finally {
      groq.close();
    }
  });

  it("answers without reasoning when a model doesn't offer it", async () => {
    const groq = await groqServer((_, n) =>
      n === 1 ? { status: 400, error: "reasoning_format is not supported with this model" } : { chunks: ANSWER.slice(2) },
    );
    try {
      const events = await collect("qwen/qwen3.8-27b");
      expect(groq.bodies).toHaveLength(2);
      expect(groq.bodies[1].reasoning_format).toBe("hidden");
      expect(events).toContainEqual({ type: "text", text: "Blue light scatters most." });
      expect(events.some((e) => e.type === "notice")).toBe(false);
    } finally {
      groq.close();
    }
  });
});
