import { describe, expect, it } from "vitest";
import { canvasBlocks, canvasFromLang, codeFileName, codeLanguage, displayTitle, fenceFor, withoutCanvasBlocks } from "@/lib/canvas";

describe("canvas blocks", () => {
  it("finds a finished canvas in a reply", () => {
    const text = "Here's a draft.\n\n```canvas:Wedding-speech\n# A toast\n\nThank you.\n```\n\nWant changes?";
    expect(canvasBlocks(text)).toEqual([{ title: "Wedding-speech", content: "# A toast\n\nThank you.", closed: true }]);
  });

  it("sees a canvas still being written as open", () => {
    expect(canvasBlocks("Sure.\n\n```canvas:app.py\nprint(1)\n")).toEqual([{ title: "app.py", content: "print(1)\n", closed: false }]);
  });

  it("keeps code fences inside a canvas opened with four backticks", () => {
    const text = "````canvas:Guide\nRun this:\n```bash\nnpm test\n```\nDone.\n````";
    expect(canvasBlocks(text)[0]).toEqual({ title: "Guide", content: "Run this:\n```bash\nnpm test\n```\nDone.", closed: true });
  });

  it("ignores canvas examples inside other code blocks", () => {
    expect(canvasBlocks("````md\n```canvas:Nope\nx\n```\n````")).toEqual([]);
  });

  it("cleans titles", () => {
    expect(canvasFromLang("canvas:../etc/passwd")).toBe("etc-passwd");
    expect(canvasFromLang("canvas:")).toBeNull();
    expect(canvasFromLang("file:Plan.docx")).toBeNull();
  });

  it("swaps old canvas texts for a note in the history the model sees", () => {
    const text = "Done.\n\n```canvas:Plan\nlong text\n```\n\nAnd code:\n```js\nx\n```";
    expect(withoutCanvasBlocks(text)).toBe('Done.\n\n[Wrote the canvas "Plan" here.]\n\nAnd code:\n```js\nx\n```');
  });

  it("tells code from documents and names them for people", () => {
    expect(codeLanguage("budget.py")).toBe("Python");
    expect(codeLanguage("Wedding-speech")).toBeNull();
    expect(displayTitle("Wedding-speech")).toBe("Wedding speech");
    expect(displayTitle("my_app.py")).toBe("my_app.py");
  });

  it("never saves a page or picture as something a browser would open", () => {
    expect(codeFileName("index.html")).toBe("index.html.txt");
    expect(codeFileName("logo.svg")).toBe("logo.svg.txt");
    expect(codeFileName("app.py")).toBe("app.py");
  });

  it("picks a fence longer than any inside", () => {
    expect(fenceFor("plain")).toBe("```");
    expect(fenceFor("has ```js fences```")).toBe("````");
  });
});
