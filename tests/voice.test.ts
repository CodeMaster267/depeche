import { describe, expect, it } from "vitest";
import { readyToSpeak, speakable } from "@/lib/voice/text";
import { encodeWav } from "@/lib/voice/client";

describe("speakable", () => {
  it("drops Markdown symbols, code and footnotes so replies read naturally", () => {
    const md = "## Answer\n\n**Yes**, see [the docs](https://x.y)[^1].\n\n```js\nalert(1)\n```\n\n- one\n- two\n\n[^1]: Source";
    const out = speakable(md);
    expect(out).toContain("Answer");
    expect(out).toContain("Yes, see the docs.");
    expect(out).toContain("(code shown on screen)");
    expect(out).not.toMatch(/[*#`[\]]/);
    expect(out).not.toContain("alert");
    expect(out).not.toContain("https");
    expect(speakable("It rained [1](https://a.b) today.")).toBe("It rained today.");
  });
});

describe("readyToSpeak", () => {
  it("waits for a sentence before speaking, then takes whole sentences", () => {
    expect(readyToSpeak("Hello there", false, true).ready).toBe("");
    const t = "This is the first full sentence of the reply, long enough. And this is the second one, still";
    const first = readyToSpeak(t, false, true);
    expect(first.ready).toBe("This is the first full sentence of the reply, long enough.");
    expect(first.rest).toBe(" And this is the second one, still");
  });
  it("holds back while a code block is unfinished, and gives everything once done", () => {
    const t = "Here is some code for you to look at right now, please read it.\n```js\nlet a = 1.";
    expect(readyToSpeak(t, false, true).ready).toBe("");
    expect(readyToSpeak(t, true, true).ready).toBe(t);
  });
});

describe("encodeWav", () => {
  it("makes a 16 kHz mono 16-bit WAV from 48 kHz audio", async () => {
    const second = new Float32Array(48_000).map((_, i) => Math.sin(i / 10) * 0.5);
    const wav = encodeWav([second.subarray(0, 20_000), second.subarray(20_000)], 48_000, 48_000);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(16_000 * 2);
    expect(bytes.length).toBe(44 + 32_000);
  });
});
