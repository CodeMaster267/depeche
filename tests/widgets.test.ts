import { describe, expect, it } from "vitest";
import { checkWidgetEvent, MAX_HEIGHT, MAX_SEND, widgetDocument, widgetFromLang } from "@/lib/widgets/frame";

const theme = { dark: false, fg: "#111111", bg: "rgb(255, 255, 255)", mute: "#666", line: "#ddd", font: '"Geist", system-ui, sans-serif' };

describe("gadgets", () => {
  it("reads the title from the block label, and only from widget blocks", () => {
    expect(widgetFromLang("widget:Tip-calculator")).toBe("Tip calculator");
    expect(widgetFromLang("widget")).toBe("Gadget");
    expect(widgetFromLang("widget:<script>")).toBe("script");
    expect(widgetFromLang("python")).toBeNull();
    expect(widgetFromLang(undefined)).toBeNull();
  });

  it("puts the no-network policy before anything the model wrote", () => {
    const doc = widgetDocument('<meta http-equiv="Content-Security-Policy" content="default-src *"><p>hi</p>', theme);
    const policy = doc.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(doc.indexOf("<p>hi</p>")).toBeGreaterThan(policy);
    expect(doc.slice(0, doc.indexOf("\n"))).toContain("default-src 'none'");
    expect(doc.slice(0, doc.indexOf("\n"))).not.toContain("connect-src");
    expect(doc).toContain("--depeche-fg:#111111");
  });

  it("drops page colours that could break out of the style", () => {
    const doc = widgetDocument("", { ...theme, fg: "red}</style><script>alert(1)</script>", font: "x;}body{display:none" });
    expect(doc).not.toContain("alert(1)");
    expect(doc).toContain("--depeche-fg:#000");
    expect(doc).toContain("--depeche-font:system-ui, sans-serif");
  });

  it("checks what a tool posts back", () => {
    expect(checkWidgetEvent({ kind: "height", value: 99999 })).toEqual({ kind: "height", value: MAX_HEIGHT });
    expect(checkWidgetEvent({ kind: "height", value: "5" })).toBeNull();
    expect(checkWidgetEvent({ kind: "send", text: "  Total £46‮  " })).toEqual({ kind: "send", text: "Total £46" });
    expect(checkWidgetEvent({ kind: "send", text: "x".repeat(MAX_SEND + 10) })?.kind).toBe("send");
    expect((checkWidgetEvent({ kind: "send", text: "x".repeat(MAX_SEND + 10) }) as { text: string }).text).toHaveLength(MAX_SEND);
    expect(checkWidgetEvent({ kind: "send", text: "   " })).toBeNull();
    expect(checkWidgetEvent({ kind: "navigate", text: "https://x" })).toBeNull();
    expect(checkWidgetEvent(null)).toBeNull();
  });
});
