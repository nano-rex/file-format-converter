import { createZip, readZip, zipText } from "./zip.js";
import { child, escapeXml, find, findAll, kids, parseXml, readRels, resolveTarget, textOf } from "./xml.js";
import { appPropsXml, corePropsXml, packageRels } from "./docx.js";

const builtinDateFormats = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const builtinTimeFormats = new Set([18, 19, 20, 21, 45, 46, 47]);

// Reads every visible worksheet. Returns [{ name, rows }] with display strings.
export function readXlsxSheets(buffer) {
  const entries = readZip(buffer);
  let workbookPath = "xl/workbook.xml";
  for (const rel of readRels(zipText(entries, "_rels/.rels")).values()) {
    if (rel.type.endsWith("/officeDocument")) workbookPath = resolveTarget("", rel.target);
  }
  if (!entries.has(workbookPath)) throw new Error("This file is not an Excel workbook (xl/workbook.xml is missing).");

  const workbook = parseXml(zipText(entries, workbookPath));
  const relsPath = workbookPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const rels = readRels(zipText(entries, relsPath));
  const date1904 = ["1", "true"].includes(find(workbook, "workbookPr")?.attrs.date1904);

  let sharedStrings = [];
  let formats = [];
  for (const rel of rels.values()) {
    const path = resolveTarget(workbookPath, rel.target);
    if (rel.type.endsWith("/sharedStrings")) sharedStrings = readSharedStrings(zipText(entries, path));
    else if (rel.type.endsWith("/styles")) formats = readCellFormats(zipText(entries, path));
  }

  const sheets = [];
  for (const sheet of findAll(workbook, "sheet")) {
    if (sheet.attrs.state === "hidden" || sheet.attrs.state === "veryHidden") continue;
    const relId = sheet.attrs["r:id"] ?? Object.entries(sheet.attrs).find(([key]) => key.endsWith(":id"))?.[1];
    const rel = rels.get(relId);
    if (!rel || !rel.type.endsWith("/worksheet")) continue;
    const path = resolveTarget(workbookPath, rel.target);
    if (!entries.has(path)) continue;
    const rows = readWorksheet(zipText(entries, path), sharedStrings, formats, date1904);
    sheets.push({ name: sheet.attrs.name || `Sheet${sheets.length + 1}`, rows });
  }
  if (!sheets.length) throw new Error("This workbook has no visible worksheets with cell data.");
  return sheets;
}

export function readXlsx(buffer, title) {
  const sheets = readXlsxSheets(buffer);
  const filled = sheets.filter(sheet => sheet.rows.length);
  return {
    title,
    source: "xlsx",
    pages: (filled.length ? filled : sheets.slice(0, 1)).map(sheet => ({
      name: sheet.name,
      width: 841.89,
      height: 595.28,
      blocks: sheet.rows.length ? [{ type: "table", rows: sheet.rows }] : []
    }))
  };
}

function richText(node) {
  let out = "";
  for (const item of node.children) {
    if (item.local === "t") out += textOf(item);
    else if (item.local === "r") out += textOf(child(item, "t"));
  }
  return decodeEscapes(out);
}

// Excel stores control characters as _xHHHH_ sequences.
function decodeEscapes(text) {
  return text.includes("_x") ? text.replaceAll(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return code === 13 ? "" : String.fromCharCode(code);
  }) : text;
}

function readSharedStrings(xml) {
  return findAll(parseXml(xml), "si").map(richText);
}

function readCellFormats(xml) {
  const root = parseXml(xml);
  const custom = new Map();
  for (const format of findAll(child(child(root, "styleSheet"), "numFmts"), "numFmt")) {
    custom.set(Number(format.attrs.numFmtId), format.attrs.formatCode || "");
  }
  return kids(child(child(root, "styleSheet"), "cellXfs"), "xf").map(xf => {
    const id = Number(xf.attrs.numFmtId || 0);
    const code = custom.get(id);
    if (code !== undefined) {
      const plain = code.replaceAll(/"[^"]*"|\[[^\]]*\]|\\./g, "");
      if (/[dyhs]/i.test(plain) || (/m/i.test(plain) && !/[0#?]/.test(plain))) {
        return { kind: "date", time: !/[dy]/i.test(plain) };
      }
      if (plain.includes("%")) return { kind: "percent" };
      return { kind: "general" };
    }
    if (builtinDateFormats.has(id)) return { kind: "date", time: builtinTimeFormats.has(id) };
    if (id === 9 || id === 10) return { kind: "percent" };
    return { kind: "general" };
  });
}

function cleanNumber(value) {
  return String(Number(value.toPrecision(15)));
}

function formatNumber(raw, format, date1904) {
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value)) return raw;
  if (format?.kind === "date") {
    const serial = date1904 ? value + 1462 : value;
    const date = new Date(Math.round((serial - 25569) * 86400) * 1000);
    if (Number.isNaN(date.getTime())) return cleanNumber(value);
    const iso = date.toISOString();
    const day = iso.slice(0, 10);
    const time = iso.slice(11, 19);
    if (format.time && value < 1) return time;
    return Number.isInteger(value) ? day : `${day} ${time}`;
  }
  if (format?.kind === "percent") return `${cleanNumber(value * 100)}%`;
  return cleanNumber(value);
}

function readWorksheet(xml, sharedStrings, formats, date1904) {
  const data = find(parseXml(xml), "sheetData");
  const rows = [];
  let nextRow = 1;
  for (const rowNode of kids(data, "row")) {
    const rowNumber = Number(rowNode.attrs.r) || nextRow;
    // Keep blank rows so the layout survives, but never expand a huge gap.
    for (let gap = Math.min(rowNumber - nextRow, 50); gap > 0; gap -= 1) rows.push([]);
    nextRow = rowNumber + 1;

    const row = [];
    let nextColumn = 0;
    for (const cell of kids(rowNode, "c")) {
      const ref = /^([A-Za-z]+)/.exec(cell.attrs.r || "");
      const column = ref ? columnIndex(ref[1].toUpperCase()) - 1 : nextColumn;
      nextColumn = column + 1;
      if (column > 16383) continue;

      const type = cell.attrs.t || "n";
      const raw = textOf(child(cell, "v"));
      let value = "";
      if (type === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (type === "inlineStr") value = child(cell, "is") ? richText(child(cell, "is")) : "";
      else if (type === "str" || type === "e" || type === "d") value = decodeEscapes(raw);
      else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
      else value = formatNumber(raw, formats[Number(cell.attrs.s || 0)], date1904);

      if (value !== "") row[column] = value;
    }
    rows.push(Array.from(row, value => value ?? ""));
  }

  while (rows.length && rows[rows.length - 1].every(value => value === "")) rows.pop();
  const width = Math.max(0, ...rows.map(row => {
    let last = row.length;
    while (last > 0 && row[last - 1] === "") last -= 1;
    return last;
  }));
  return rows.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

export function columnName(index) {
  let name = "";
  for (let rest = index; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + (rest - 1) % 26) + name;
  }
  return name;
}

function columnIndex(name) {
  let index = 0;
  for (const char of name) index = index * 26 + char.charCodeAt(0) - 64;
  return index;
}

// ---------------------------------------------------------------------------
// Writer

export function writeXlsx(sheets, title) {
  const used = new Set();
  const named = (sheets.length ? sheets : [{ name: "Sheet1", rows: [] }]).map((sheet, index) => {
    let name = String(sheet.name || `Sheet${index + 1}`).replaceAll(/[\[\]:*?/\\\u0000-\u001f]/g, " ").trim().slice(0, 31) || `Sheet${index + 1}`;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
      const tail = ` (${suffix})`;
      name = name.slice(0, 31 - tail.length) + tail;
    }
    used.add(name.toLowerCase());
    return { name, rows: sheet.rows };
  });

  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ["_rels/.rels", packageRels("xl/workbook.xml")],
    ["docProps/core.xml", corePropsXml(title)],
    ["docProps/app.xml", appPropsXml()],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`]
  ];
  named.forEach((sheet, index) => files.push([`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet.rows)]));
  return createZip(files);
}

function worksheetXml(rows) {
  const widths = [];
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((raw, column) => {
      const value = String(raw ?? "");
      if (value === "") return "";
      const longest = value.split("\n").reduce((most, line) => Math.max(most, line.length), 0);
      widths[column] = Math.max(widths[column] || 0, longest);
      const ref = `${columnName(column + 1)}${rowIndex + 1}`;
      if (/^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(value) && value.replace(/\D/g, "").length <= 15) {
        return `<c r="${ref}"><v>${value}</v></c>`;
      }
      if (/^-?\d{1,3}(,\d{3})+(\.\d{1,10})?$/.test(value) && value.replace(/\D/g, "").length <= 15) {
        return `<c r="${ref}" s="${value.includes(".") ? 2 : 1}"><v>${value.replaceAll(",", "")}</v></c>`;
      }
      const style = value.includes("\n") ? " s=\"3\"" : "";
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value.slice(0, 32767))}</t></is></c>`;
    }).join("");
    return cells ? `<row r="${rowIndex + 1}">${cells}</row>` : "";
  }).join("");

  const columns = [];
  for (let column = 0; column < widths.length; column += 1) {
    const width = Math.min(60, Math.max(8.43, (widths[column] || 0) * 1.15 + 2));
    columns.push(`<col min="${column + 1}" max="${column + 1}" width="${width.toFixed(2)}" customWidth="1"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${columns.length ? `<cols>${columns.join("")}</cols>` : ""}<sheetData>${body}</sheetData></worksheet>`;
}
