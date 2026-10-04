import { basename } from "node:path";

export function stem(name) {
  const base = basename(String(name || "converted").replaceAll("\\", "/"));
  const index = base.lastIndexOf(".");
  const clean = (index > 0 ? base.slice(0, index) : base).replaceAll(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
  return clean || "converted";
}

export function parseCsv(text) {
  const source = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(source);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"" && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(source) {
  const firstLine = source.slice(0, source.search(/\r|\n|$/));
  const counts = [",", ";", "\t"].map(char => [char, firstLine.split(char).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n\r]/.test(str) ? `"${str.replaceAll("\"", "\"\"")}"` : str;
}

export function rowsToCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export function rowsToObjects(rows) {
  const [first = [], ...rest] = rows;
  const seen = new Map();
  const headers = first.map((header, index) => {
    const base = String(header ?? "").trim() || `column${index + 1}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
  return rest.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

export function isCjk(char) {
  const code = char.codePointAt(0);
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x3ffff);
}

// Helvetica advance widths for codes 32-126, in 1/1000 em. Used to wrap text
// when writing PDFs and as a fallback when a PDF font carries no width table.
export const helveticaWidths = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

export function charWidth(char) {
  const code = char.codePointAt(0);
  if (code >= 32 && code <= 126) return helveticaWidths[code - 32];
  if (isCjk(char)) return 1000;
  if (code >= 0xc0 && code <= 0x24f) {
    const base = char.normalize("NFD").codePointAt(0);
    if (base >= 32 && base <= 126) return helveticaWidths[base - 32];
  }
  return 556;
}

export function textWidth(text, size) {
  let total = 0;
  for (const char of text) total += charWidth(char);
  return total * size / 1000;
}
