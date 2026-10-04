import { createZip, readZip, zipText } from "./zip.js";
import { child, escapeXml, find, findAll, kids, parseXml, readRels, resolveTarget, textOf } from "./xml.js";

const officeDocumentType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

export function readDocx(buffer, title) {
  const entries = readZip(buffer);
  let documentPath = "word/document.xml";
  for (const rel of readRels(zipText(entries, "_rels/.rels")).values()) {
    if (rel.type.endsWith("/officeDocument")) documentPath = resolveTarget("", rel.target);
  }
  if (!entries.has(documentPath)) throw new Error("This file is not a Word document (word/document.xml is missing).");

  const folder = documentPath.split("/").slice(0, -1).join("/");
  const headings = readHeadingStyles(zipText(entries, `${folder}/styles.xml`));
  const numbering = readNumbering(zipText(entries, `${folder}/numbering.xml`));
  const body = find(parseXml(zipText(entries, documentPath)), "body");
  if (!body) throw new Error("This Word document has no readable body.");

  const pages = [{ blocks: [] }];
  const context = { headings, numbering, counters: new Map(), pages };
  readBlocks(body, context);

  let width = 612;
  let height = 792;
  const sections = findAll(body, "pgSz");
  const size = sections[sections.length - 1];
  if (size && Number(size.attrs.w) > 0 && Number(size.attrs.h) > 0) {
    width = Number(size.attrs.w) / 20;
    height = Number(size.attrs.h) / 20;
  }
  const kept = pages.filter(page => page.blocks.length);
  if (!kept.length) kept.push({ blocks: [] });
  for (const page of kept) Object.assign(page, { width, height });
  return { title, source: "docx", pages: kept };
}

function readHeadingStyles(xml) {
  const levels = new Map();
  for (const style of findAll(parseXml(xml), "style")) {
    const id = style.attrs.styleId;
    const name = (child(style, "name")?.attrs.val || "").toLowerCase();
    const match = name.match(/^heading (\d)$/);
    const outline = find(style, "outlineLvl");
    if (match) levels.set(id, Number(match[1]));
    else if (name === "title") levels.set(id, 1);
    else if (name === "subtitle") levels.set(id, 2);
    else if (outline) levels.set(id, Number(outline.attrs.val) + 1);
  }
  return levels;
}

function readNumbering(xml) {
  const root = parseXml(xml);
  const abstracts = new Map();
  for (const abstract of findAll(root, "abstractNum")) {
    const levels = new Map();
    for (const level of kids(abstract, "lvl")) {
      levels.set(level.attrs.ilvl, {
        format: child(level, "numFmt")?.attrs.val || "decimal",
        start: Number(child(level, "start")?.attrs.val || 1)
      });
    }
    abstracts.set(abstract.attrs.abstractNumId, levels);
  }
  const numbers = new Map();
  for (const num of findAll(root, "num")) {
    numbers.set(num.attrs.numId, abstracts.get(child(num, "abstractNumId")?.attrs.val) || new Map());
  }
  return numbers;
}

function readBlocks(container, context) {
  for (const node of container.children) {
    if (node.local === "p") {
      readParagraph(node, context);
    } else if (node.local === "tbl") {
      const rows = readTable(node, context);
      if (rows.length) currentPage(context).blocks.push({ type: "table", rows });
    } else if (node.local === "sdt") {
      const content = child(node, "sdtContent");
      if (content) readBlocks(content, context);
    } else if (node.local === "customXml" || node.local === "smartTag" || node.local === "ins") {
      readBlocks(node, context);
    }
  }
}

function currentPage(context) {
  return context.pages[context.pages.length - 1];
}

function readParagraph(node, context) {
  const properties = child(node, "pPr");
  const state = { boxes: [], pageBreak: false };
  let text = inlineText(node, state).replace(/[ \t]+$/g, "");
  if (child(properties, "pageBreakBefore") && child(properties, "pageBreakBefore").attrs.val !== "0") {
    context.pages.push({ blocks: [] });
  }

  const styleId = child(properties, "pStyle")?.attrs.val;
  const outline = child(properties, "outlineLvl");
  let level = context.headings.get(styleId) || 0;
  if (!level && outline && Number(outline.attrs.val) < 9) level = Number(outline.attrs.val) + 1;

  const numPr = child(properties, "numPr");
  if (numPr && text.trim() && !level) {
    text = listPrefix(numPr, context) + text;
  }

  if (text.trim()) {
    const bold = isBold(node);
    if (level) currentPage(context).blocks.push({ type: "heading", level: Math.min(level, 3), text: text.trim() });
    else currentPage(context).blocks.push({ type: "paragraph", text, bold });
  }
  for (const box of state.boxes) readBlocks(box, context);
  if (state.pageBreak) context.pages.push({ blocks: [] });
}

function listPrefix(numPr, context) {
  const numId = child(numPr, "numId")?.attrs.val || "0";
  const level = child(numPr, "ilvl")?.attrs.val || "0";
  if (numId === "0") return "";
  const definition = context.numbering.get(numId)?.get(level) || { format: "bullet", start: 1 };
  const indent = "  ".repeat(Number(level) || 0);
  if (definition.format === "bullet" || definition.format === "none") return `${indent}• `;

  const key = `${numId}:${level}`;
  const value = (context.counters.get(key) ?? definition.start - 1) + 1;
  context.counters.set(key, value);
  for (const other of context.counters.keys()) {
    const [otherId, otherLevel] = other.split(":");
    if (otherId === numId && Number(otherLevel) > Number(level)) context.counters.delete(other);
  }
  let label = String(value);
  if (definition.format === "lowerLetter") label = letters(value);
  else if (definition.format === "upperLetter") label = letters(value).toUpperCase();
  else if (definition.format === "lowerRoman") label = roman(value);
  else if (definition.format === "upperRoman") label = roman(value).toUpperCase();
  return `${indent}${label}. `;
}

function letters(value) {
  let out = "";
  for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) out = String.fromCharCode(97 + (rest - 1) % 26) + out;
  return out;
}

function roman(value) {
  const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let rest = value;
  let out = "";
  for (const [amount, symbol] of table) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

function isBold(paragraph) {
  const runs = findAll(paragraph, "r").filter(run => textOf(child(run, "t")).trim());
  if (!runs.length) return false;
  return runs.every(run => {
    const bold = child(child(run, "rPr"), "b");
    return bold && bold.attrs.val !== "0" && bold.attrs.val !== "false";
  });
}

function inlineText(node, state) {
  let out = "";
  for (const item of node.children) {
    switch (item.local) {
      case "t":
        out += textOf(item);
        break;
      case "tab":
      case "ptab":
        out += "\t";
        break;
      case "br":
        if (item.attrs.type === "page") state.pageBreak = true;
        else out += "\n";
        break;
      case "cr":
        out += "\n";
        break;
      case "noBreakHyphen":
        out += "-";
        break;
      case "sym": {
        const code = Number.parseInt(item.attrs.char || "", 16);
        if (code) out += String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code);
        break;
      }
      case "pPr":
      case "rPr":
      case "del":
      case "moveFrom":
      case "delText":
      case "instrText":
      case "#text":
        break;
      case "AlternateContent": {
        const branch = child(item, "Choice") || child(item, "Fallback");
        if (branch) out += inlineText(branch, state);
        break;
      }
      case "txbxContent":
        state.boxes.push(item);
        break;
      default:
        out += inlineText(item, state);
    }
  }
  return out;
}

function readTable(table, context) {
  const rows = [];
  const visit = container => {
    for (const node of container.children) {
      if (node.local === "tr") {
        const row = [];
        for (const cell of rowCells(node)) {
          const nested = { ...context, pages: [{ blocks: [] }] };
          readBlocks(cell, nested);
          const text = nested.pages.flatMap(page => page.blocks).map(block => (
            block.type === "table" ? block.rows.map(item => item.join(" | ")).join("\n") : block.text
          )).join("\n").trim();
          row.push(text);
          const span = Number(find(child(cell, "tcPr"), "gridSpan")?.attrs.val || 1);
          for (let extra = 1; extra < span && extra < 64; extra += 1) row.push("");
        }
        rows.push(row);
      } else if (node.local === "sdt") {
        const content = child(node, "sdtContent");
        if (content) visit(content);
      }
    }
  };
  visit(table);
  const width = Math.max(0, ...rows.map(row => row.length));
  for (const row of rows) {
    while (row.length < width) row.push("");
  }
  return rows.filter(row => row.length);
}

function rowCells(row) {
  const cells = [];
  for (const node of row.children) {
    if (node.local === "tc") cells.push(node);
    else if (node.local === "sdt") cells.push(...kids(child(node, "sdtContent"), "tc"));
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Writer

export function writeDocx(doc) {
  const first = doc.pages[0] || {};
  const width = Math.round((first.width || 612) * 20);
  const height = Math.round((first.height || 792) * 20);
  const margin = 1080;
  const textWidth = width - 2 * margin;
  const compact = doc.source === "txt";
  const body = [];

  doc.pages.forEach((page, index) => {
    if (index > 0) body.push("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
    if (page.name) body.push(paragraphXml(page.name, { style: "Heading2" }));
    for (const block of page.blocks) {
      if (block.type === "heading") {
        body.push(paragraphXml(block.text, { style: `Heading${block.level || 1}` }));
      } else if (block.type === "table") {
        body.push(tableXml(block.rows, textWidth), "<w:p/>");
      } else {
        body.push(paragraphXml(block.text, { bold: block.bold, compact }));
      }
    }
  });

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="${width}" w:h="${height}"${width > height ? " w:orient=\"landscape\"" : ""}/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  return createZip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ["_rels/.rels", packageRels("word/document.xml")],
    ["docProps/core.xml", corePropsXml(doc.title)],
    ["docProps/app.xml", appPropsXml()],
    ["word/document.xml", document],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["word/styles.xml", stylesXml()]
  ]);
}

function paragraphXml(text, { style, bold, compact } = {}) {
  const properties = [];
  if (style) properties.push(`<w:pStyle w:val="${style}"/>`);
  if (compact) properties.push("<w:spacing w:after=\"0\"/>");
  const runProperties = bold && !style ? "<w:rPr><w:b/></w:rPr>" : "";
  const pieces = [];
  String(text ?? "").split(/(\n|\t)/).forEach(piece => {
    if (piece === "\n") pieces.push("<w:br/>");
    else if (piece === "\t") pieces.push("<w:tab/>");
    else if (piece) pieces.push(`<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`);
  });
  const run = pieces.length ? `<w:r>${runProperties}${pieces.join("")}</w:r>` : "";
  return `<w:p>${properties.length ? `<w:pPr>${properties.join("")}</w:pPr>` : ""}${run}</w:p>`;
}

function tableXml(rows, textWidth) {
  const columns = Math.max(1, ...rows.map(row => row.length));
  const weights = Array.from({ length: columns }, (_, column) => {
    const longest = Math.max(0, ...rows.map(row => String(row[column] ?? "").split("\n").reduce((most, line) => Math.max(most, line.length), 0)));
    return Math.min(40, Math.max(4, longest));
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map(weight => Math.max(300, Math.floor(textWidth * weight / total)));
  const border = side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;
  const grid = widths.map(value => `<w:gridCol w:w="${value}"/>`).join("");
  const body = rows.map((row, rowIndex) => {
    const cells = widths.map((value, column) => (
      `<w:tc><w:tcPr><w:tcW w:w="${value}" w:type="dxa"/></w:tcPr>${paragraphXml(row[column] ?? "", { bold: rowIndex === 0 && rows.length > 1, compact: true })}</w:tc>`
    )).join("");
    return `<w:tr>${cells}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

function stylesXml() {
  const heading = (level, size, before) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading(1, 36, 360)}${heading(2, 30, 280)}${heading(3, 26, 240)}</w:styles>`;
}

export function packageRels(target) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${officeDocumentType}" Target="${target}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

export function corePropsXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title || "")}</dc:title><dc:creator>File Format Converter</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

export function appPropsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>File Format Converter</Application></Properties>`;
}
