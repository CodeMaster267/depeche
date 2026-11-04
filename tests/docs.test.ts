import { describe, expect, it } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { DOCX, PPTX, XLSX, isFileRef, readAsText, refusal, storedType } from "@/lib/chat/files";
import { documentText } from "@/lib/docs/read";
import { alternatives, buildFile, fileFromLang, markdownToDocx, parseCsv, parseSheets, tableToXlsx } from "@/lib/docs/write";

/** Reading Word, Excel and PowerPoint files, and making files from what a model writes. */

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe("picking files", () => {
  it("stores Word, Excel and PowerPoint files under their own types", () => {
    expect(storedType({ name: "Report.docx", type: "" })).toBe(DOCX);
    expect(storedType({ name: "Budget.XLSX", type: "application/octet-stream" })).toBe(XLSX);
    expect(storedType({ name: "deck.pptx", type: PPTX })).toBe(PPTX);
    expect(readAsText(DOCX) && readAsText("text/plain") && !readAsText("application/pdf")).toBe(true);
    expect(isFileRef({ path: "me/x/a.docx", name: "a.docx", mime: DOCX, size: 10 }, "me")).toBe(true);
  });

  it("says how to send old Office and Apple files", () => {
    expect(storedType({ name: "old.doc", type: "application/msword" })).toBeNull();
    expect(refusal({ name: "old.doc" })).toMatch(/\.docx/);
    expect(refusal({ name: "Budget.numbers" })).toMatch(/Export/);
    expect(refusal({ name: "song.mp3" })).toBe("Can't send this kind of file");
  });
});

describe("reading documents", () => {
  it("reads a Word document as Markdown: headings, lists, tables, footnotes", async () => {
    const md = "# Trip\n\nA **bold** plan & more.\n\n- Passport\n- Chargers\n\n| Day | Plan |\n| --- | --- |\n| Mon | Museum |\n\nSee note[^1].\n\n[^1]: Bring cash.";
    const text = await documentText(DOCX, markdownToDocx(md));
    expect(text).toContain("# Trip");
    expect(text).toContain("A bold plan & more.");
    expect(text).toContain("- Passport\n- Chargers");
    expect(text).toContain("| Day | Plan |\n| --- | --- |\n| Mon | Museum |");
    expect(text).toContain("Bring cash.");
  });

  it("reads every sheet of a spreadsheet as CSV, with dates as dates", async () => {
    const book = tableToXlsx('Item,Cost\nEggs,2.5\n"Milk, whole",1\n## Sheet: Second\nA,B\n1,2');
    expect(await documentText(XLSX, book)).toBe('## Sheet: Sheet1\n\nItem,Cost\nEggs,2.5\n"Milk, whole",1\n\n## Sheet: Second\n\nA,B\n1,2');

    // A sheet as Excel itself writes it: shared strings, a date-formatted number, a sparse row.
    const files = unzipSync(book);
    files["xl/sharedStrings.xml"] = strToU8('<sst><si><t>When</t></si><si><r><t>Big </t></r><r><t>day</t></r></si></sst>');
    files["xl/styles.xml"] = strToU8('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>');
    files["xl/worksheets/sheet1.xml"] = strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="1"><v>46329</v></c><c r="C2" t="s"><v>1</v></c></row></sheetData></worksheet>',
    );
    const text = await documentText(XLSX, zipSync(files));
    expect(text).toContain("When\n2026-11-03,,Big day");
  });

  it("reads each slide of a presentation with its notes", async () => {
    const slide = (t: string) => `<p:sld><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>Point &amp; more</a:t></a:r></a:p></p:txBody></p:sld>`;
    const deck = zipSync({
      "ppt/slides/slide2.xml": strToU8(slide("Second")),
      "ppt/slides/slide10.xml": strToU8(slide("Tenth")),
      "ppt/slides/slide1.xml": strToU8(slide("First")),
      "ppt/slides/_rels/slide1.xml.rels": strToU8('<Relationships><Relationship Target="../notesSlides/notesSlide1.xml"/></Relationships>'),
      "ppt/notesSlides/notesSlide1.xml": strToU8("<p:notes><a:p><a:r><a:t>Say hello</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>"),
    });
    const text = await documentText(PPTX, deck);
    expect(text).toBe("## Slide 1\n\nFirst\nPoint & more\n\nNotes: Say hello\n\n## Slide 2\n\nSecond\nPoint & more\n\n## Slide 3\n\nTenth\nPoint & more");
  });

  it("refuses files that unpack to far more than they say, and files of the wrong kind", async () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(70 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(documentText(DOCX, bomb)).rejects.toThrow(/unpacks/);
    await expect(documentText(DOCX, tableToXlsx("a,b"))).rejects.toThrow(/Word/);
    await expect(documentText(XLSX, new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it("keeps very long documents to the same limit as text files", async () => {
    const text = await documentText(DOCX, markdownToDocx("word ".repeat(60_000)));
    expect(text.length).toBeLessThan(200_100);
    expect(text).toMatch(/too long to include/);
  });
});

describe("making files", () => {
  it("knows a file block from its label", () => {
    expect(fileFromLang("file:Trip-plan.docx")).toEqual({ name: "Trip-plan.docx", kind: "docx" });
    expect(fileFromLang("file:notes.markdown")).toEqual({ name: "notes.markdown", kind: "md" });
    expect(fileFromLang("file:../../etc/passwd.txt")?.name).toBe("etc-passwd.txt");
    // Kinds that could run code are never made.
    expect(fileFromLang("file:page.html")).toBeNull();
    expect(fileFromLang("file:pic.svg")).toBeNull();
    expect(fileFromLang("file:.pdf")).toBeNull();
    expect(fileFromLang("python")).toBeNull();
    expect(alternatives("docx")).toEqual(["pdf", "md"]);
    expect(alternatives("xlsx")).toEqual(["csv"]);
  });

  it("writes a Word document that is a real Word document", async () => {
    const { blob } = await buildFile("docx", "# Hi\n\n1. One\n2. Two\n\n[site](https://example.com) <b>raw</b> & \u0007");
    expect(blob.type).toBe(DOCX);
    const files = unzipSync(await bytes(blob));
    expect(Object.keys(files).sort()).toEqual(
      ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/numbering.xml", "word/styles.xml"].sort(),
    );
    const doc = strFromU8(files["word/document.xml"]);
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain("&lt;b&gt;");
    expect(doc).toContain(" &amp; ");
    expect(doc).not.toContain("<b>");
    expect(doc).not.toContain("\u0007");
    expect(strFromU8(files["word/_rels/document.xml.rels"])).toContain('Target="https://example.com" TargetMode="External"');
  });

  it("writes spreadsheets with numbers as numbers and formulas as formulas", async () => {
    expect(parseCsv('a,"b, c","say ""hi"""\n1,2,3\n\n')).toEqual([["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseSheets("| A | B |\n| - | - |\n| 1 | 2 |")[0].rows).toEqual([["A", "B"], ["1", "2"]]);
    const sheet = strFromU8(unzipSync(tableToXlsx("Item,Cost,Code\nEggs,2.5,007\nTotal,=SUM(B2:B2),"))["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain('<c r="B2"><v>2.5</v></c>');
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">007</t></is></c>');
    expect(sheet).toContain('<c r="B3"><f>SUM(B2:B2)</f></c>');
  });

  it("writes a PDF, and says when letters had to be left out", async () => {
    const plain = await buildFile("pdf", "# Hello\n\nCafé “quoted” → done.\n\n| A | B |\n|---|---|\n| 1 | 2 |", "Hello.pdf");
    const head = new TextDecoder().decode((await bytes(plain.blob)).slice(0, 5));
    expect(head).toBe("%PDF-");
    expect(plain.lossy).toBe(false);
    expect((await buildFile("pdf", "Salaam: السلام عليكم")).lossy).toBe(true);
    // Long text runs onto more pages.
    const long = await buildFile("pdf", Array.from({ length: 200 }, (_, i) => `Paragraph ${i} `.repeat(20)).join("\n\n"));
    expect(long.blob.size).toBeGreaterThan(plain.blob.size);
  });

  it("writes CSV that Excel opens with accents intact", async () => {
    const { blob } = await buildFile("csv", "| Name | City |\n|---|---|\n| Zoë | Köln, DE |");
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(await bytes(blob))).toBe('﻿Name,City\nZoë,"Köln, DE"\n');
  });
});
