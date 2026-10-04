// Conversion entry point shared by the HTTP server and the command line.
// Every reader produces the same document model:
//   { title, source, pages: [{ name?, width, height, blocks, items? }] }
// where a block is a heading, a paragraph, or a table of string cells.

import { readPdf } from "./pdf-reader.js";
import { layoutPdf } from "./pdf-layout.js";
import { writePdf } from "./pdf-writer.js";
import { readDocx, writeDocx } from "./docx.js";
import { readXlsx, writeXlsx } from "./xlsx.js";
import { readPptx, writePptx } from "./pptx.js";
import { escapeXml } from "./xml.js";
import { readZip } from "./zip.js";
import { parseCsv, rowsToCsv, rowsToObjects, stem } from "./util.js";

export const engineConversions = {
  pdf: ["txt", "html", "docx", "xlsx", "pptx", "csv"],
  docx: ["txt", "html", "pdf", "pptx"],
  xlsx: ["csv", "json", "txt", "html", "pdf", "docx"],
  pptx: ["txt", "html", "pdf", "docx"],
  txt: ["docx", "pdf", "pptx"],
  csv: ["xlsx", "pdf", "docx", "html"]
};

const mimeTypes = {
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

export function normalizeFormat(format) {
  const value = String(format || "").toLowerCase().replace(/^\./, "");
  return { jpg: "jpeg", htm: "html", text: "txt", xlsm: "xlsx", docm: "docx", pptm: "pptx" }[value] || value;
}

// Looks at the file's content, so a wrong or missing extension still converts.
function sniffFormat(buffer, declared) {
  if (buffer.subarray(0, 1024).includes("%PDF-")) return "pdf";
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return "ole";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try {
      const entries = readZip(buffer);
      if (entries.has("word/document.xml")) return "docx";
      if (entries.has("xl/workbook.xml")) return "xlsx";
      if (entries.has("ppt/presentation.xml")) return "pptx";
    } catch {
      // Not a readable ZIP; fall back to the declared format.
    }
  }
  return declared;
}

export function convert(buffer, originalName, sourceFormat, targetFormat) {
  const declared = normalizeFormat(sourceFormat);
  const target = normalizeFormat(targetFormat);
  const source = sniffFormat(buffer, declared);

  if (source === "ole") {
    throw new Error(["doc", "xls", "ppt"].includes(declared)
      ? `Legacy binary .${declared} files are not supported. Save the file as .${declared}x and convert that instead.`
      : "This file is a legacy or password-protected Office document, which cannot be read. Save it as an unprotected .docx, .xlsx, or .pptx file first.");
  }
  if (!engineConversions[source]) throw new Error(`${(source || "unknown").toUpperCase()} files are not supported as conversion input.`);
  if (!engineConversions[source].includes(target)) {
    throw new Error(`${source.toUpperCase()} to ${target.toUpperCase()} is not supported. ${source.toUpperCase()} converts to: ${engineConversions[source].join(", ").toUpperCase()}.`);
  }
  if (!buffer.length) throw new Error("The uploaded file is empty.");

  const base = stem(originalName);
  const doc = readDocument(buffer, source, base);
  const output = (data, name = `${base}.${target}`) => ({ name, type: mimeTypes[target], data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8") });

  switch (target) {
    case "txt":
      return [output(toText(doc))];
    case "html":
      return [output(toHtml(doc))];
    case "docx":
      return [output(writeDocx(doc))];
    case "pdf":
      return [output(writePdf(doc))];
    case "pptx":
      return [output(writePptx(doc))];
    case "xlsx":
      return [output(writeXlsx(toSheets(doc), doc.title))];
    case "csv": {
      const sheets = toSheets(doc).filter(sheet => sheet.rows.length);
      if (source === "xlsx" && sheets.length > 1) {
        return sheets.map(sheet => output(`﻿${rowsToCsv(sheet.rows)}`, `${base}-${stem(sheet.name)}.csv`));
      }
      return [output(`﻿${rowsToCsv(sheets.flatMap(sheet => sheet.rows))}`)];
    }
    case "json": {
      const sheets = toSheets(doc);
      const value = sheets.length === 1
        ? rowsToObjects(sheets[0].rows)
        : Object.fromEntries(sheets.map(sheet => [sheet.name, rowsToObjects(sheet.rows)]));
      return [output(`${JSON.stringify(value, null, 2)}\n`)];
    }
    default:
      throw new Error(`${target.toUpperCase()} output is not supported.`);
  }
}

function readDocument(buffer, source, title) {
  switch (source) {
    case "pdf":
      return layoutPdf(readPdf(buffer), title);
    case "docx":
      return readDocx(buffer, title);
    case "xlsx":
      return readXlsx(buffer, title);
    case "pptx":
      return readPptx(buffer, title);
    case "csv": {
      const rows = parseCsv(decodeText(buffer));
      return { title, source: "csv", pages: [{ width: 841.89, height: 595.28, blocks: rows.length ? [{ type: "table", rows }] : [] }] };
    }
    default: {
      const pages = decodeText(buffer).split("\f").map(chunk => ({
        width: 595.28,
        height: 841.89,
        blocks: chunk.replace(/\s+$/, "").split(/\r?\n/).map(line => ({ type: "paragraph", text: line.replace(/\s+$/, "") }))
      }));
      return { title, source: "txt", pages };
    }
  }
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  return text.includes("�") ? buffer.toString("latin1") : text;
}

function toSheets(doc) {
  const fallback = doc.source === "pdf" ? "Page" : "Sheet";
  return doc.pages.map((page, index) => {
    const rows = [];
    page.blocks.forEach((block, blockIndex) => {
      if (block.type === "table") {
        for (const row of block.rows) rows.push(row.map(value => String(value ?? "")));
      } else {
        if (block.type === "heading" && blockIndex > 0 && rows.length && rows[rows.length - 1].length) rows.push([]);
        rows.push(block.cells ? block.cells.slice() : [block.text]);
      }
    });
    return { name: page.name || `${fallback} ${index + 1}`, rows };
  });
}

function toText(doc) {
  const named = doc.pages.length > 1 && doc.pages.some(page => page.name);
  const separator = doc.source === "txt" ? "\n" : "\n\n";
  const pages = doc.pages.map(page => {
    const parts = page.blocks.map(block => {
      if (block.type === "table") return block.rows.map(row => row.map(cell => String(cell ?? "").replaceAll(/\s*\n\s*/g, " ")).join("\t")).join("\n");
      return block.lines ? block.lines.join("\n") : block.text;
    });
    if (named && page.name) parts.unshift(`=== ${page.name} ===`);
    return parts.join(separator);
  });
  return `${pages.join("\n\n\n").replace(/\s+$/, "")}\n`;
}

function toHtml(doc) {
  const text = value => escapeXml(value).replaceAll("\n", "<br>").replaceAll("\t", "&emsp;");
  const sections = doc.pages.map(page => {
    const parts = [];
    if (page.name) parts.push(`<h2 class="page-name">${text(page.name)}</h2>`);
    for (const block of page.blocks) {
      if (block.type === "heading") {
        parts.push(`<h${block.level || 1}>${text(block.text)}</h${block.level || 1}>`);
      } else if (block.type === "table") {
        const rows = block.rows.map((row, index) => {
          const tag = index === 0 && block.rows.length > 1 ? "th" : "td";
          return `<tr>${row.map(cell => `<${tag}>${text(cell)}</${tag}>`).join("")}</tr>`;
        });
        parts.push(`<table>\n${rows.join("\n")}\n</table>`);
      } else if (block.text.trim()) {
        parts.push(`<p>${block.bold ? "<strong>" : ""}${text(block.text)}${block.bold ? "</strong>" : ""}</p>`);
      }
    }
    return `<section>\n${parts.join("\n")}\n</section>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(doc.title || "Converted document")}</title>
<style>
body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1b1b1b; }
section + section { border-top: 1px solid #ccc; margin-top: 2rem; padding-top: 1rem; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #999; padding: 0.3rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f0f0f0; }
</style>
</head>
<body>
${sections.join("\n")}
</body>
</html>
`;
}
