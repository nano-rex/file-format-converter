// Native PDF writer: lays out headings, paragraphs, and tables across pages
// with word wrapping. Latin text uses the built-in Helvetica fonts; Chinese,
// Japanese, and Korean text uses the standard CJK fonts every PDF viewer
// substitutes locally, so nothing has to be embedded.

import { deflateSync } from "node:zlib";
import { isCjk, textWidth } from "./util.js";

const winAnsiExtras = new Map(Object.entries({
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
  "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
  "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  "−": 0x2d, "‐": 0x2d, "‑": 0x2d, "●": 0x95, "▪": 0x95, " ": 0x20, " ": 0x20, " ": 0x20
}));

const cjkFonts = {
  chinese: { base: "STSong-Light", encoding: "UniGB-UCS2-H", ordering: "GB1", supplement: 4 },
  japanese: { base: "HeiseiMin-W3", encoding: "UniJIS-UCS2-H", ordering: "Japan1", supplement: 2 },
  korean: { base: "HYSMyeongJo-Medium", encoding: "UniKS-UCS2-H", ordering: "Korea1", supplement: 1 }
};

function winAnsiCode(char) {
  const code = char.codePointAt(0);
  if ((code >= 32 && code <= 126) || (code >= 0xa1 && code <= 0xff)) return code;
  if (winAnsiExtras.has(char)) return winAnsiExtras.get(char);
  const base = char.normalize("NFKD").codePointAt(0);
  return base >= 32 && base <= 126 ? base : 0x3f;
}

// Breaks text into lines no wider than maxWidth. CJK characters may break anywhere.
function wrapText(text, size, maxWidth) {
  const lines = [];
  for (const source of String(text ?? "").replaceAll("\t", "    ").split("\n")) {
    const tokens = source.match(/[^\S\n]+|[⺀-鿿가-힯豈-﫿＀-￯]|[^\s⺀-鿿가-힯豈-﫿＀-￯]+/g) || [];
    let line = "";
    let width = 0;
    for (let token of tokens) {
      let tokenWidth = textWidth(token, size);
      if (width + tokenWidth <= maxWidth || (!line && tokenWidth <= maxWidth)) {
        line += token;
        width += tokenWidth;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      width = 0;
      if (!token.trim()) continue;
      // A single word wider than the column is split by character.
      while (tokenWidth > maxWidth && token.length > 1) {
        let count = 0;
        let partial = 0;
        for (const char of token) {
          const charSize = textWidth(char, size);
          if (partial + charSize > maxWidth && count > 0) break;
          partial += charSize;
          count += char.length;
        }
        lines.push(token.slice(0, count));
        token = token.slice(count);
        tokenWidth = textWidth(token, size);
      }
      line = token;
      width = tokenWidth;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function writePdf(doc) {
  const allText = doc.pages.flatMap(page => page.blocks).map(block => (
    block.type === "table" ? block.rows.flat().join("") : block.text
  )).join("");
  const hanFont = /[぀-ヿ]/.test(allText) ? "japanese" : "chinese";
  const usedCjk = new Set();
  const fontFor = char => {
    const code = char.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7af) return "korean";
    return hanFont;
  };

  const pages = [];
  let page = null;
  let y = 0;
  let margin = 54;

  const drawText = (x, baseline, text, size, bold) => {
    let ops = "";
    let mode = "";
    let buffer = "";
    const flush = () => {
      if (!buffer) return;
      if (mode === "latin") ops += `/${bold ? "F2" : "F1"} ${size} Tf (${buffer}) Tj `;
      else ops += `/${mode} ${size} Tf <${buffer}> Tj `;
      buffer = "";
    };
    for (const char of text) {
      const code = char.codePointAt(0);
      if (isCjk(char) && code <= 0xffff) {
        const name = fontFor(char);
        usedCjk.add(name);
        if (mode !== name) flush();
        mode = name;
        buffer += code.toString(16).padStart(4, "0");
      } else {
        if (mode !== "latin") flush();
        mode = "latin";
        const byte = winAnsiCode(char);
        if (byte === 0x28 || byte === 0x29 || byte === 0x5c) buffer += `\\${String.fromCharCode(byte)}`;
        else if (byte < 127) buffer += String.fromCharCode(byte);
        else buffer += `\\${byte.toString(8).padStart(3, "0")}`;
      }
    }
    flush();
    if (ops) page.ops.push(`BT ${num(x)} ${num(page.height - baseline)} Td ${ops}ET`);
  };
  const drawLine = (x1, y1, x2, y2) => {
    page.ops.push(`${num(x1)} ${num(page.height - y1)} m ${num(x2)} ${num(page.height - y2)} l S`);
  };
  const newPage = (width, height) => {
    page = { width, height, ops: ["0.5 w 0.6 G"] };
    pages.push(page);
    margin = Math.min(54, width / 10);
    y = margin;
  };
  const ensure = needed => {
    if (y + needed > page.height - margin && y > margin) newPage(page.width, page.height);
  };
  const paragraph = (text, size, bold, spaceAfter, indent = 0) => {
    const leading = size * 1.35;
    for (const line of wrapText(text, size, page.width - 2 * margin - indent)) {
      ensure(leading);
      if (line) drawText(margin + indent, y + size, line, size, bold);
      y += leading;
    }
    y += spaceAfter;
  };

  const compact = doc.source === "txt";
  const slides = doc.source === "pptx";
  const bodySize = slides ? 16 : 10.5;
  const headingSizes = slides ? { 1: 28, 2: 22, 3: 18 } : { 1: 18, 2: 14.5, 3: 12 };

  for (const source of doc.pages.length ? doc.pages : [{ blocks: [] }]) {
    newPage(source.width || 595.28, source.height || 841.89);
    if (source.name && !slides) paragraph(source.name, headingSizes[2], true, 6);

    for (const block of source.blocks) {
      if (block.type === "heading") {
        const size = headingSizes[block.level] || headingSizes[3];
        if (y > margin) y += size * 0.5;
        ensure(size * 2.7);
        paragraph(block.text, size, true, size * 0.35);
      } else if (block.type === "table") {
        drawTable(block.rows);
        y += 10;
      } else {
        const lead = compact ? (block.text.match(/^ */)[0].length) * bodySize * 0.278 : 0;
        paragraph(compact ? block.text.trimStart() : block.text, bodySize, block.bold, compact ? 0 : bodySize * 0.55, Math.min(lead, page.width / 2));
      }
    }
  }

  function drawTable(rows) {
    const columns = Math.max(1, ...rows.map(row => row.length));
    const available = page.width - 2 * margin;
    const size = Math.max(5.5, Math.min(slides ? 12 : 9, available / columns / 4.2));
    const padding = Math.max(1.5, size * 0.4);
    const leading = size * 1.25;
    const natural = Array.from({ length: columns }, (_, column) => {
      let widest = size * 2;
      for (const row of rows) {
        for (const line of String(row[column] ?? "").split("\n")) widest = Math.max(widest, textWidth(line, size));
      }
      return Math.min(widest, available * 0.45) + 2 * padding;
    });
    let widths = natural;
    const total = natural.reduce((sum, width) => sum + width, 0);
    if (total > available) {
      // Shrink wide columns first; narrow ones keep their natural width when possible.
      const fair = available / columns;
      const narrow = natural.filter(width => width <= fair);
      const rest = available - narrow.reduce((sum, width) => sum + width, 0);
      const wideTotal = total - narrow.reduce((sum, width) => sum + width, 0);
      widths = natural.map(width => (width <= fair ? width : Math.max(2 * padding + size, width * rest / wideTotal)));
    }
    const tableWidth = widths.reduce((sum, width) => sum + width, 0);
    const maxLines = Math.max(1, Math.floor((page.height - 2 * margin - 2 * padding) / leading));

    let segmentTop = null;
    const closeSegment = () => {
      if (segmentTop === null) return;
      let x = margin;
      drawLine(x, segmentTop, x, y);
      for (const width of widths) {
        x += width;
        drawLine(x, segmentTop, x, y);
      }
      segmentTop = null;
    };

    rows.forEach((row, rowIndex) => {
      const cells = widths.map((width, column) => wrapText(row[column] ?? "", size, width - 2 * padding).slice(0, maxLines));
      const rowHeight = Math.max(1, ...cells.map(lines => lines.length)) * leading + 2 * padding;
      if (y + rowHeight > page.height - margin && y > margin) {
        closeSegment();
        newPage(page.width, page.height);
      }
      if (segmentTop === null) {
        segmentTop = y;
        drawLine(margin, y, margin + tableWidth, y);
      }
      let x = margin;
      cells.forEach((lines, column) => {
        lines.forEach((line, index) => {
          if (line) drawText(x + padding, y + padding + size + index * leading, line, size, rowIndex === 0 && rows.length > 1);
        });
        x += widths[column];
      });
      y += rowHeight;
      drawLine(margin, y, margin + tableWidth, y);
    });
    closeSegment();
  }

  return assemble(pages, usedCjk, doc.title);
}

function num(value) {
  return Number(value.toFixed(2)).toString();
}

function assemble(pages, usedCjk, title) {
  const objects = [];
  const add = body => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add(null);
  const pagesId = add(null);
  const fonts = [
    ["F1", add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")],
    ["F2", add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")]
  ];
  for (const name of usedCjk) {
    const font = cjkFonts[name];
    const descriptor = add(`<< /Type /FontDescriptor /FontName /${font.base} /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>`);
    const descendant = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${font.base} /CIDSystemInfo << /Registry (Adobe) /Ordering (${font.ordering}) /Supplement ${font.supplement} >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`);
    fonts.push([name, add(`<< /Type /Font /Subtype /Type0 /BaseFont /${font.base} /Encoding /${font.encoding} /DescendantFonts [${descendant} 0 R] >>`)]);
  }
  const resources = `<< /Font << ${fonts.map(([name, id]) => `/${name} ${id} 0 R`).join(" ")} >> >>`;

  const pageIds = pages.map(page => {
    const data = deflateSync(Buffer.from(page.ops.join("\n"), "latin1"));
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from("\nendstream")]));
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources ${resources} /Contents ${content} 0 R >>`);
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  const titleHex = Buffer.from(`﻿${title || ""}`, "utf16le").swap16().toString("hex");
  const infoId = add(`<< /Title <${titleHex}> /Producer (File Format Converter) >>`);

  const chunks = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
  const offsets = [];
  let position = chunks[0].length;
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n")]);
    offsets.push(position);
    position += chunk.length;
    chunks.push(chunk);
  });
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${position}\n%%EOF\n`;
  chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}
