import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SPEC, cleanSpec, cleanText, hex } from "@/lib/design/spec";
import { contrast, makeReadable } from "@/lib/design/contrast";
import { designCss } from "@/lib/design/css";
import { familyFriendly } from "@/lib/design/friendly";

vi.mock("server-only", () => ({}));
const { GADGET_BUILDERS, judge, pickBuilder, readJson } = await import("@/lib/design/build");

describe("cleaning a design", () => {
  it("keeps only allowed values, on top of the current design", () => {
    const spec = cleanSpec(
      {
        name: "Beach",
        mode: "sideways",
        light: { bg: "#FFF", fg: "red", accent: "#00aaff" },
        fonts: { body: "caveat", headings: "caveat", wordmark: "comic-sans" },
        textScale: 9,
        layout: { sidebarPhone: "right", sidebarDesktop: "top" },
        shortcuts: [{ piece: "memory", place: "header", label: "My <b>memory</b>" }, { piece: "rm -rf", place: "header" }, { piece: "memory", place: "header" }],
        hide: ["spending", "composer", "spending"],
        regions: { composer: { background: "accent", radius: 999, text: "auto" }, "sign-in": { background: "bg" } },
        texts: { greeting: "Ahoy {name}! <script>" },
      },
      DEFAULT_SPEC,
    );
    expect(spec.name).toBe("Beach");
    expect(spec.mode).toBe("auto");
    expect(spec.light.bg).toBe("#ffffff");
    expect(spec.light.fg).toBe(DEFAULT_SPEC.light.fg);
    expect(spec.light.accent).toBe("#00aaff");
    // Handwriting is for headings only.
    expect(spec.fonts).toEqual({ body: "geist", headings: "caveat", wordmark: "archivo" });
    expect(spec.textScale).toBe(1.4);
    expect(spec.layout.sidebarPhone).toBe("right");
    expect(spec.layout.sidebarDesktop).toBe("left");
    expect(spec.shortcuts).toEqual([{ piece: "memory", place: "header", label: "My bmemory/b" }]);
    expect(spec.hide).toEqual(["spending"]);
    expect(spec.regions).toEqual({ composer: { background: "accent", radius: 40, text: "auto" } });
    expect(spec.texts.greeting).toBe("Ahoy {name}! script");
  });

  it("never throws on rubbish", () => {
    for (const junk of [null, 1, "x", [], { light: 5, regions: [1], shortcuts: "no" }]) expect(() => cleanSpec(junk)).not.toThrow();
  });

  it("reads colours and text safely", () => {
    expect(hex("#AbC")).toBe("#aabbcc");
    expect(hex("url(x)")).toBeNull();
    expect(cleanText("a‮b\n c")).toBe("a b c");
  });
});

describe("readability", () => {
  it("fixes text that would be hard to read, in light and dark", () => {
    const pale = cleanSpec({ light: { fg: "#eeeeee", mute: "#f0f0f0" }, dark: { fg: "#111111" } });
    const { spec, fixes } = makeReadable(pale);
    expect(contrast(spec.light.fg, spec.light.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(spec.light.mute, spec.light.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(spec.dark.fg, spec.dark.bg)).toBeGreaterThanOrEqual(4.5);
    expect(fixes.length).toBeGreaterThan(0);
  });

  it("leaves standard Depeche alone", () => {
    expect(makeReadable(DEFAULT_SPEC).fixes).toEqual([]);
  });

  it("gives a region black or white text when its colours clash", () => {
    const clash = cleanSpec({ light: { accent: "#ffee00" }, regions: { composer: { background: "accent", text: "accent" } } });
    expect(makeReadable(clash).spec.regions.composer?.text).toBe("auto");
  });
});

describe("styles", () => {
  it("only ever contains checked values", () => {
    const css = designCss(cleanSpec({ light: { bg: "#123456" }, layout: { sidebarPhone: "right" }, hide: ["keyboard-hint"], backdrop: "dots" }));
    expect(css).toContain("--bg:#123456");
    expect(css).toContain("[data-part=drawer]{left:auto;right:0}");
    expect(css).toContain("[data-part=keyboard-hint]{display:none!important}");
    expect(css).not.toMatch(/url\(|expression|@import|<\/style/i);
  });

  it("never hides the chat, the box or the chats list", () => {
    const css = designCss(cleanSpec({ hide: ["composer", "thread", "sidebar", "menu-button"] }));
    expect(css).not.toContain("display:none");
  });
});

describe("family friendly", () => {
  it("catches rude words, even disguised", () => {
    expect(familyFriendly("make it look like a beach")).toBe(true);
    expect(familyFriendly("Essex blue and Scunthorpe green")).toBe(true);
    expect(familyFriendly("put sh!t everywhere")).toBe(false);
    expect(familyFriendly("a NSFW theme")).toBe(false);
  });

  it("turns down designs whose words aren't", () => {
    expect(judge({ name: "Rude", summary: "x", texts: { greeting: "hey shit" } }, DEFAULT_SPEC).kind).toBe("refused");
    expect(judge({ refuse: "Not family friendly." }, DEFAULT_SPEC)).toEqual({ kind: "refused", reason: "Not family friendly." });
  });
});

describe("building", () => {
  it("reads JSON wrapped in fences or words", () => {
    expect(readJson('```json\n{"name":"A"}\n```')).toEqual({ name: "A" });
    expect(readJson("no json here")).toBeUndefined();
  });

  it("picks the strongest model the family's keys allow", () => {
    // My look: Opus, then Argon, then Sol, never Fable and nothing else.
    expect(pickBuilder([{ provider: "anthropic", models: null }])?.id).toBe("claude-opus-5-5");
    expect(pickBuilder([{ provider: "anthropic", models: ["claude-fable-5-1"] }, { provider: "google", models: null }])?.id).toBe("gemini-4-argon");
    expect(pickBuilder([{ provider: "anthropic", models: ["claude-sonnet-5-5"] }, { provider: "openai", models: null }])?.id).toBe("gpt-6.1-sol");
    expect(pickBuilder([{ provider: "google", models: ["gemini-3.8-flash"] }])).toBeUndefined();
    expect(pickBuilder([])).toBeUndefined();
    // Gadget changes: strongest first, never Fable.
    expect(pickBuilder([{ provider: "anthropic", models: null }], GADGET_BUILDERS)?.id).toBe("claude-opus-5-5");
    expect(pickBuilder([{ provider: "google", models: ["gemini-3.8-flash"] }], GADGET_BUILDERS)?.id).toBe("gemini-3.8-flash");
  });
});
