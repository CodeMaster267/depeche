import { zipSync, strToU8 } from "fflate";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Root, RootContent, PhrasingContent, Table, List, AlignType } from "mdast";
import { KINDS, type Built, type DocKind } from "./kinds";

/**
 * Makes the files a model writes in a chat (see lib/docs/kinds.ts), in the browser.
 * Word and PDF files are written from Markdown, spreadsheets from CSV (or a Markdown table).
 * Only these kinds are made, and only as downloads: a model's HTML or scripts never run here.
 */
export { KINDS, alternatives, fileFromLang, withKind, type Built, type DocKind } from "./kinds";

export async function buildFile(kind: DocKind, content: string, name = "Document"): Promise<Built> {
  const type = KINDS[kind].mime;
  switch (kind) {
    case "docx":
      return { blob: new Blob([toBuffer(markdownToDocx(content))], { type }), lossy: false };
    case "xlsx":
      return { blob: new Blob([toBuffer(tableToXlsx(content))], { type }), lossy: false };
    case "pdf": {
      const { bytes, lossy } = await markdownToPdf(content, name);
      return { blob: new Blob([toBuffer(bytes)], { type }), lossy };
    }
    case "csv": {
      // If the model wrote a Markdown table, save it as real CSV. A byte-order mark lets Excel
      // open accented letters correctly.
      const sheets = parseSheets(content);
      const csv = sheets.length === 1 && content.trim().startsWith("|") ? toCsv(sheets[0].rows) : content;
      return { blob: new Blob(["﻿", csv.endsWith("\n") ? csv : `${csv}\n`], { type }), lossy: false };
    }
    default:
      return { blob: new Blob([content.endsWith("\n") ? content : `${content}\n`], { type }), lossy: false };
  }
}

const toBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/* ------------------------------------------------------------------------------------------ */
/* Shared: Markdown in, simple styled runs out.                                                 */

type Run = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: string };

function parseMarkdown(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

function runsOf(nodes: PhrasingContent[], style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out.push({ ...style, text: n.value });
        break;
      case "strong":
        out.push(...runsOf(n.children, { ...style, bold: true }));
        break;
      case "emphasis":
        out.push(...runsOf(n.children, { ...style, italic: true }));
        break;
      case "delete":
        out.push(...runsOf(n.children, { ...style, strike: true }));
        break;
      case "inlineCode":
        out.push({ ...style, text: n.value, code: true });
        break;
      case "link":
        out.push(...runsOf(n.children, { ...style, link: n.url }));
        break;
      case "linkReference":
        out.push(...runsOf(n.children, style));
        break;
      case "image":
      case "imageReference":
        if (n.alt) out.push({ ...style, text: `[${n.alt}]`, italic: true });
        break;
      case "break":
        out.push({ ...style, text: "\n" });
        break;
      case "footnoteReference":
        out.push({ ...style, text: `[${n.label ?? n.identifier}]` });
        break;
      case "html":
        out.push({ ...style, text: n.value });
        break;
      default:
        if ("children" in n) out.push(...runsOf((n as { children: PhrasingContent[] }).children, style));
        else if ("value" in n) out.push({ ...style, text: String((n as { value: unknown }).value) });
    }
  }
  return out;
}

const plainOf = (nodes: PhrasingContent[]) => runsOf(nodes).map((r) => r.text).join("");

/* ------------------------------------------------------------------------------------------ */
/* Word (.docx)                                                                                 */

const xmlEscape = (s: string) =>
  s
    // Characters XML can't hold at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export function markdownToDocx(md: string): Uint8Array {
  const links: string[] = [];
  // Each list gets its own numbering, so numbered lists start again from their own first number.
  const nums: { abstract: 0 | 1; level: number; start: number }[] = [];

  const run = (r: Run): string => {
    const props =
      (r.link ? '<w:rStyle w:val="Hyperlink"/>' : "") +
      (r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : "") +
      (r.bold ? "<w:b/><w:bCs/>" : "") +
      (r.italic ? "<w:i/><w:iCs/>" : "") +
      (r.strike ? "<w:strike/>" : "");
    const body = r.text
      .split(/(\n|\t)/)
      .map((part) => (part === "\n" ? "<w:br/>" : part === "\t" ? "<w:tab/>" : part ? `<w:t xml:space="preserve">${xmlEscape(part)}</w:t>` : ""))
      .join("");
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
  };
  const runs = (rs: Run[]) => {
    let xml = "";
    for (let i = 0; i < rs.length; i++) {
      const link = rs[i].link;
      if (link && /^(https?:|mailto:)/i.test(link)) {
        let j = i;
        let inner = "";
        while (j < rs.length && rs[j].link === link) inner += run(rs[j++]);
        links.push(link);
        xml += `<w:hyperlink r:id="rLink${links.length}" w:history="1">${inner}</w:hyperlink>`;
        i = j - 1;
      } else xml += run({ ...rs[i], link: undefined });
    }
    return xml;
  };
  const para = (content: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${content}</w:p>`;

  const table = (t: Table): string => {
    const columns = Math.max(...t.children.map((r) => r.children.length));
    const align = (a: AlignType | undefined) => (a === "center" ? '<w:jc w:val="center"/>' : a === "right" ? '<w:jc w:val="right"/>' : "");
    const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
    const rows = t.children
      .map((row, r) => {
        const cells = Array.from({ length: columns }, (_, c) => {
          const cell = row.children[c];
          const rs = cell ? runsOf(cell.children, r === 0 ? { bold: true } : {}) : [];
          return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(runs(rs), `<w:spacing w:before="40" w:after="40"/>${align(t.align?.[c] ?? undefined)}`)}</w:tc>`;
        }).join("");
        return `<w:tr>${r === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
      })
      .join("");
    const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${Math.floor(9000 / columns)}"/>`).join("");
    return (
      `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
      `<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>` +
      para("")
    );
  };

  const footnotes: string[] = [];
  const block = (n: RootContent, ctx: { quote?: boolean; indent?: number } = {}): string => {
    const quote = ctx.quote ? '<w:pStyle w:val="Quote"/>' : "";
    const indent = ctx.indent ? `<w:ind w:left="${ctx.indent}"/>` : "";
    switch (n.type) {
      case "heading":
        return para(runs(runsOf(n.children)), `<w:pStyle w:val="Heading${n.depth}"/>`);
      case "paragraph":
        return para(runs(runsOf(n.children)), quote + indent);
      case "blockquote":
        return n.children.map((c) => block(c, { ...ctx, quote: true })).join("");
      case "list":
        return list(n, 0, ctx);
      case "code":
        return n.value
          .split("\n")
          .map((line) => para(run({ text: line, code: true }), `<w:pStyle w:val="Code"/>${indent}`))
          .join("");
      case "math":
        return para(run({ text: n.value, code: true }), `<w:pStyle w:val="Code"/>`);
      case "table":
        return table(n);
      case "thematicBreak":
        return para("", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr>');
      case "html":
        return para(run({ text: n.value }), quote + indent);
      case "footnoteDefinition":
        footnotes.push(
          `[${n.label ?? n.identifier}] ` +
            n.children.map((c) => ("children" in c ? plainOf(c.children as PhrasingContent[]) : "")).join(" "),
        );
        return "";
      default:
        return "";
    }
  };
  const list = (l: List, level: number, ctx: { quote?: boolean }): string => {
    nums.push({ abstract: l.ordered ? 1 : 0, level: Math.min(level, 8), start: l.start ?? 1 });
    const numId = nums.length;
    return l.children
      .map((item) =>
        item.children
          .map((c, i) => {
            if (c.type === "list") return list(c, level + 1, ctx);
            if (i === 0 && c.type === "paragraph") {
              const check = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
              return para(
                (check ? run({ text: check }) : "") + runs(runsOf(c.children)),
                `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${Math.min(level, 8)}"/><w:numId w:val="${numId}"/></w:numPr>`,
              );
            }
            return block(c, { ...ctx, indent: 720 * (level + 1) });
          })
          .join(""),
      )
      .join("");
  };

  const tree = parseMarkdown(md);
  let body = tree.children.map((n) => block(n)).join("");
  if (footnotes.length) body += para(runs([{ text: "Notes", bold: true }])) + footnotes.map((f) => para(runs([{ text: f }]))).join("");

  const document =
    `${XML_HEAD}<w:document ${W_NS}><w:body>${body || para("")}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1304" w:bottom="1440" w:left="1304" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";

  const bullets = ["•", "◦", "▪"];
  const levels = (abstract: 0 | 1) =>
    Array.from({ length: 9 }, (_, l) =>
      abstract === 0
        ? `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${bullets[l % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
        : `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${["decimal", "lowerLetter", "lowerRoman"][l % 3]}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`,
    ).join("");
  const numbering =
    `${XML_HEAD}<w:numbering ${W_NS}>` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(0)}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(1)}</w:abstractNum>` +
    nums
      .map(
        (n, i) =>
          `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${n.abstract}"/><w:lvlOverride w:ilvl="${n.level}"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`,
      )
      .join("") +
    "</w:numbering>";

  const heading = (level: number, size: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  const styles =
    `${XML_HEAD}<w:styles ${W_NS}>` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    [36, 30, 26, 24, 22, 22].map((size, i) => heading(i + 1, size)).join("") +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="000000"/></w:pBdr></w:pPr><w:rPr><w:i/><w:iCs/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    "</w:styles>";

  const rel = (id: string, type: string, target: string, external = false) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${xmlEscape(target)}"${external ? ' TargetMode="External"' : ""}/>`;
  const docRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rel("rStyles", "styles", "styles.xml") +
    rel("rNumbering", "numbering", "numbering.xml") +
    links.map((l, i) => rel(`rLink${i + 1}`, "hyperlink", l, true)).join("") +
    "</Relationships>";

  return zipSync({
    "[Content_Types].xml": strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rDoc", "officeDocument", "word/document.xml")}</Relationships>`,
    ),
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8(styles),
    "word/numbering.xml": strToU8(numbering),
    "word/_rels/document.xml.rels": strToU8(docRels),
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Spreadsheets (.xlsx)                                                                         */

type Sheet = { name: string; rows: string[][] };

/** RFC 4180 CSV (commas, or tabs when every line has them), quoted fields allowed. */
export function parseCsv(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const first = lines.split("\n").find((l) => l.trim()) ?? "";
  const sep = first.includes("\t") && !first.includes(",") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < lines.length; i++) {
    const ch = lines[i];
    if (quoted) {
      if (ch === '"' && lines[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function markdownRows(text: string): string[][] {
  const tree = parseMarkdown(text);
  const t = tree.children.find((n): n is Table => n.type === "table");
  return t ? t.children.map((r) => r.children.map((c) => plainOf(c.children))) : [];
}

/** One sheet, or several each under a "## Sheet: Name" line. */
export function parseSheets(text: string): Sheet[] {
  const parts = text.split(/^#{1,3}\s*Sheet:\s*(.+)$/im);
  const sheets: Sheet[] = [];
  const add = (name: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    sheets.push({ name, rows: trimmed.startsWith("|") ? markdownRows(trimmed) : parseCsv(trimmed) });
  };
  add("Sheet1", parts[0]);
  for (let i = 1; i < parts.length; i += 2) add(parts[i].trim(), parts[i + 1] ?? "");
  return sheets.length ? sheets : [{ name: "Sheet1", rows: [] }];
}

const toCsv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
const NUMBER = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function tableToXlsx(text: string): Uint8Array {
  const sheets = parseSheets(text);
  const used = new Set<string>();
  const names = sheets.map((s, i) => {
    let name = s.name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name.toLowerCase());
    return name;
  });

  const sheetXml = (rows: string[][]) => {
    const columns = Math.max(0, ...rows.map((r) => r.length));
    const widths = Array.from({ length: columns }, (_, c) => Math.min(60, Math.max(8, ...rows.map((r) => (r[c] ?? "").length + 2))));
    const cols = columns ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const data = rows
      .map((r, ri) => {
        const cells = r
          .map((raw, ci) => {
            const v = raw.trim();
            if (!v) return "";
            const ref = `${colName(ci)}${ri + 1}`;
            const style = ri === 0 ? ' s="1"' : "";
            if (ri > 0 && NUMBER.test(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
            if (ri > 0 && /^=[A-Z]/i.test(v)) return `<c r="${ref}"${style}><f>${xmlEscape(v.slice(1))}</f></c>`;
            return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(raw)}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    const freeze = rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "";
    return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${data}</sheetData></worksheet>`;
  };

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        // Formulas the model wrote are worked out when the file opens.
        '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows))));
  return zipSync(files);
}

/* ------------------------------------------------------------------------------------------ */
/* PDF                                                                                          */

/** Close stand-ins for characters the built-in PDF fonts lack. */
const STAND_INS: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "−": "-", "✓": "v", "✔": "v",
  "✗": "x", "✘": "x", "☐": "[ ]", "☑": "[x]", "☒": "[x]", "◦": "-", "▪": "-", "■": "-", "●": "•", " ": " ", " ": " ", " ": " ",
};

async function markdownToPdf(md: string, title: string): Promise<{ bytes: Uint8Array; lossy: boolean }> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(title.replace(/\.pdf$/i, ""));
  pdf.setCreator("Depeche");
  const font = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const charset = new Set(font.regular.getCharacterSet());
  let lossy = false;
  const clean = (s: string) =>
    Array.from(s.normalize("NFC"), (ch) => {
      if (charset.has(ch.codePointAt(0)!) || ch === "\n") return ch;
      if (STAND_INS[ch]) return STAND_INS[ch];
      // Accents the fonts lack: keep the letter.
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      if (base && Array.from(base).every((c) => charset.has(c.codePointAt(0)!))) return base;
      if (/\p{Extended_Pictographic}|[‍️]/u.test(ch)) return "";
      lossy = true;
      return "?";
    }).join("");

  const W = 595.28;
  const H = 841.89;
  const M = 56;
  const width = W - 2 * M;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const room = (h: number) => {
    if (y - h < M) newPage();
  };
  const fontFor = (r: Run) => (r.code ? font.mono : r.bold && r.italic ? font.boldItalic : r.bold ? font.bold : r.italic ? font.italic : font.regular);

  /** Lays out runs as wrapped lines within `w`, drawing them if `draw`; returns the lines' height. */
  type Piece = { text: string; run: Run; w: number };
  const wrap = (runs: Run[], size: number, w: number): Piece[][] => {
    const lines: Piece[][] = [[]];
    let x = 0;
    for (const r of runs) {
      const f = fontFor(r);
      const text = clean(r.text);
      for (const token of text.split(/(\n|\s+)/)) {
        if (!token) continue;
        if (token === "\n") {
          lines.push([]);
          x = 0;
          continue;
        }
        const space = /^\s+$/.test(token);
        if (space && x === 0) continue;
        let tw = f.widthOfTextAtSize(space ? " " : token, size);
        if (!space && x + tw > w && x > 0) {
          lines.push([]);
          x = 0;
        }
        // A word longer than the line is broken across lines.
        let rest = space ? " " : token;
        while (!space && tw > w) {
          let n = rest.length;
          while (n > 1 && f.widthOfTextAtSize(rest.slice(0, n), size) > w - x) n--;
          lines.at(-1)!.push({ text: rest.slice(0, n), run: r, w: f.widthOfTextAtSize(rest.slice(0, n), size) });
          lines.push([]);
          x = 0;
          rest = rest.slice(n);
          tw = f.widthOfTextAtSize(rest, size);
        }
        if (rest) {
          lines.at(-1)!.push({ text: rest, run: r, w: tw });
          x += tw;
        }
      }
    }
    // Trailing spaces don't count.
    for (const l of lines) while (l.length && /^\s+$/.test(l.at(-1)!.text)) l.pop();
    return lines;
  };
  const drawLine = (line: Piece[], x: number, baseline: number, size: number) => {
    for (const p of line) {
      page.drawText(p.text, { x, y: baseline, size, font: fontFor(p.run), color: rgb(0, 0, 0) });
      if (p.run.link || p.run.strike) {
        const ly = p.run.link ? baseline - 1.5 : baseline + size * 0.3;
        page.drawLine({ start: { x, y: ly }, end: { x: x + p.w, y: ly }, thickness: 0.5, color: rgb(0, 0, 0) });
      }
      x += p.w;
    }
  };
  const text = (runs: Run[], o: { size?: number; indent?: number; before?: number; after?: number; prefix?: string; bar?: boolean } = {}) => {
    const size = o.size ?? 10.5;
    const lh = size * 1.4;
    const indent = o.indent ?? 0;
    const lines = wrap(runs, size, width - indent);
    y -= o.before ?? 0;
    lines.forEach((line, i) => {
      room(lh);
      const baseline = y - size;
      if (i === 0 && o.prefix) {
        const pw = font.regular.widthOfTextAtSize(o.prefix, size);
        page.drawText(o.prefix, { x: M + indent - pw - 6, y: baseline, size, font: font.regular });
      }
      if (o.bar) page.drawLine({ start: { x: M + indent - 10, y: y + 2 }, end: { x: M + indent - 10, y: y - lh + 2 }, thickness: 1.5 });
      drawLine(line, M + indent, baseline, size);
      y -= lh;
    });
    y -= o.after ?? 6;
  };
  // Links show their address after the words, since a printed page can't be tapped.
  const withLinks = (runs: Run[]): Run[] =>
    runs.flatMap((r, i) => (r.link && runs[i + 1]?.link !== r.link && r.text.trim() !== r.link && /^https?:/.test(r.link) ? [r, { text: ` (${r.link})` }] : [r]));

  const table = (t: Table, indent: number) => {
    const rows = t.children.map((r) => r.children.map((c) => runsOf(c.children)));
    const columns = Math.max(...rows.map((r) => r.length));
    const size = 9;
    const lh = size * 1.35;
    const pad = 4;
    const w = width - indent;
    // Columns share the width by how much they hold, within limits.
    const want = Array.from({ length: columns }, (_, c) =>
      Math.max(...rows.map((r) => Math.min(60, (r[c] ?? []).map((x) => x.text).join("").length)), 3),
    );
    const total = want.reduce((a, b) => a + b, 0);
    const colW = want.map((n) => (n / total) * w);
    y -= 4;
    rows.forEach((row, ri) => {
      const cells = Array.from({ length: columns }, (_, c) =>
        wrap((row[c] ?? []).map((r) => (ri === 0 ? { ...r, bold: true } : r)), size, colW[c] - 2 * pad),
      );
      const h = Math.max(...cells.map((l) => l.length)) * lh + 2 * pad;
      room(h);
      let x = M + indent;
      cells.forEach((lines, c) => {
        if (ri === 0) page.drawRectangle({ x, y: y - h, width: colW[c], height: h, color: rgb(0.94, 0.94, 0.94) });
        page.drawRectangle({ x, y: y - h, width: colW[c], height: h, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
        lines.forEach((line, li) => drawLine(line, x + pad, y - pad - size - li * lh + 1.5, size));
        x += colW[c];
      });
      y -= h;
    });
    y -= 10;
  };

  const footnotes: Run[][] = [];
  const block = (n: RootContent, indent = 0, quote = false) => {
    switch (n.type) {
      case "heading": {
        const size = [20, 16, 13.5, 12, 11, 10.5][n.depth - 1];
        room(size * 3); // keep a heading with what follows it
        text(runsOf(n.children, { bold: true }), { size, indent, before: n.depth <= 2 ? 10 : 6, after: 4 });
        break;
      }
      case "paragraph":
        text(withLinks(runsOf(n.children, quote ? { italic: true } : {})), { indent, bar: quote });
        break;
      case "blockquote":
        for (const c of n.children) block(c, indent + 16, true);
        break;
      case "list":
        n.children.forEach((item, i) => {
          const marker = item.checked === true ? "[x]" : item.checked === false ? "[ ]" : n.ordered ? `${(n.start ?? 1) + i}.` : "•";
          item.children.forEach((c, ci) => {
            if (ci === 0 && c.type === "paragraph") text(withLinks(runsOf(c.children)), { indent: indent + 18, prefix: marker, after: 3 });
            else block(c, indent + 18, quote);
          });
        });
        y -= 3;
        break;
      case "code":
      case "math": {
        const size = 8.5;
        const lh = size * 1.4;
        const lines = n.value.split("\n").flatMap((l) => wrap([{ text: l || " ", code: true }], size, width - indent - 12));
        y -= 2;
        for (const line of lines) {
          room(lh);
          page.drawRectangle({ x: M + indent, y: y - lh, width: width - indent, height: lh, color: rgb(0.95, 0.95, 0.95) });
          drawLine(line, M + indent + 6, y - size - 1, size);
          y -= lh;
        }
        y -= 8;
        break;
      }
      case "table":
        table(n, indent);
        break;
      case "thematicBreak":
        room(14);
        page.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 0.5 });
        y -= 14;
        break;
      case "html":
        text([{ text: n.value }], { indent });
        break;
      case "footnoteDefinition":
        footnotes.push([
          { text: `[${n.label ?? n.identifier}] ` },
          ...n.children.flatMap((c) => ("children" in c ? withLinks(runsOf(c.children as PhrasingContent[])) : [])),
        ]);
        break;
    }
  };
  for (const n of parseMarkdown(md).children) block(n);
  if (footnotes.length) {
    text([{ text: "Notes", bold: true }], { before: 8 });
    for (const f of footnotes) text(f, { size: 9 });
  }

  const pages = pdf.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `${i + 1} / ${pages.length}`;
      p.drawText(label, { x: W / 2 - font.regular.widthOfTextAtSize(label, 8) / 2, y: M / 2, size: 8, font: font.regular, color: rgb(0.4, 0.4, 0.4) });
    });
  }
  return { bytes: await pdf.save(), lossy };
}
