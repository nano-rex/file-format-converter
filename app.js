const formats = [
  "auto", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "json",
  "txt", "html", "png", "jpeg", "jpg", "webp", "bmp", "gif", "svg", "mp4",
  "webm", "mkv", "mov", "mp3", "wav", "flac", "ogg"
];

const conversions = [
  ["png", "webp", "native", "Canvas image re-encoding."],
  ["jpeg", "webp", "native", "Canvas image re-encoding."],
  ["webp", "png", "native", "Canvas image re-encoding."],
  ["png", "jpeg", "native", "Canvas image re-encoding."],
  ["jpeg", "png", "native", "Canvas image re-encoding."],
  ["bmp", "png", "native", "Canvas image re-encoding."],
  ["csv", "json", "native", "Structured text conversion."],
  ["json", "csv", "native", "Structured text conversion."],
  ["txt", "html", "native", "Escapes plain text into a simple HTML document."],
  ["html", "txt", "native", "Extracts readable text from HTML markup."],
  ["txt", "json", "native", "Wraps plain text in a JSON document."],
  ["json", "txt", "native", "Pretty-prints JSON as plain text."],
  ["pdf", "png", "engine", "Needs a bundled local PDF render engine."],
  ["pdf", "jpeg", "engine", "Needs a bundled local PDF render engine."],
  ["pdf", "txt", "engine", "Needs a bundled local PDF text extractor."],
  ["xlsx", "csv", "engine", "Needs a bundled local spreadsheet parser."],
  ["xlsx", "json", "engine", "Needs a bundled local spreadsheet parser."],
  ["doc", "docx", "engine", "Needs a bundled local document conversion engine."],
  ["docx", "pdf", "engine", "Needs a bundled local document conversion engine."],
  ["pdf", "docx", "engine", "Needs OCR and layout reconstruction."],
  ["pdf", "xlsx", "engine", "Needs table extraction and workbook generation."],
  ["pdf", "pptx", "engine", "Needs slide reconstruction."],
  ["xls", "xlsx", "engine", "Needs a bundled local spreadsheet engine."],
  ["ppt", "pptx", "engine", "Needs a bundled local presentation engine."],
  ["mp4", "webm", "engine", "Needs a bundled local media encoder."],
  ["mp4", "mkv", "engine", "Needs a bundled local media encoder."],
  ["webm", "mp4", "engine", "Needs a bundled local media encoder."],
  ["wav", "mp3", "engine", "Needs a bundled local audio encoder."],
  ["flac", "wav", "engine", "Needs a bundled local audio decoder."]
];

const state = {
  files: [],
  outputs: []
};

const els = {
  fileInput: document.querySelector("#fileInput"),
  pickButton: document.querySelector("#pickButton"),
  dropzone: document.querySelector("#dropzone"),
  fromFormat: document.querySelector("#fromFormat"),
  toFormat: document.querySelector("#toFormat"),
  swapButton: document.querySelector("#swapButton"),
  convertForm: document.querySelector("#convertForm"),
  clearButton: document.querySelector("#clearButton"),
  downloadAllButton: document.querySelector("#downloadAllButton"),
  fileList: document.querySelector("#fileList"),
  resultList: document.querySelector("#resultList"),
  fileTemplate: document.querySelector("#fileTemplate"),
  resultTemplate: document.querySelector("#resultTemplate"),
  matrixGrid: document.querySelector("#matrixGrid"),
  searchInput: document.querySelector("#searchInput"),
  engineStatus: document.querySelector("#engineStatus")
};

init();

function init() {
  fillFormatSelects();
  renderMatrix();
  bindEvents();
}

function fillFormatSelects() {
  for (const fmt of formats) {
    const fromOption = new Option(fmt.toUpperCase(), fmt);
    const toOption = new Option(fmt.toUpperCase(), fmt);
    els.fromFormat.append(fromOption);
    els.toFormat.append(toOption);
  }
  els.toFormat.value = "png";
}

function bindEvents() {
  els.pickButton.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", event => addFiles(event.target.files));
  els.clearButton.addEventListener("click", clearAll);
  els.swapButton.addEventListener("click", swapFormats);
  els.convertForm.addEventListener("submit", event => {
    event.preventDefault();
    convertQueuedFiles();
  });
  els.downloadAllButton.addEventListener("click", downloadAll);
  els.searchInput.addEventListener("input", () => renderMatrix(els.searchInput.value));

  for (const name of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(name, event => {
      event.preventDefault();
      els.dropzone.classList.add("active");
    });
  }
  for (const name of ["dragleave", "drop"]) {
    els.dropzone.addEventListener(name, event => {
      event.preventDefault();
      els.dropzone.classList.remove("active");
    });
  }
  els.dropzone.addEventListener("drop", event => addFiles(event.dataTransfer.files));
}

function addFiles(fileList) {
  const incoming = [...fileList];
  state.files.push(...incoming);
  if (incoming[0]) {
    els.fromFormat.value = extensionFor(incoming[0]) || "auto";
  }
  renderFiles();
}

function clearAll() {
  state.files = [];
  state.outputs.forEach(output => URL.revokeObjectURL(output.url));
  state.outputs = [];
  els.fileInput.value = "";
  renderFiles();
  renderResults();
  setStatus("Standalone engine ready");
}

function swapFormats() {
  const from = els.fromFormat.value;
  els.fromFormat.value = els.toFormat.value;
  els.toFormat.value = from === "auto" ? "png" : from;
}

function renderFiles() {
  els.fileList.replaceChildren();
  for (const file of state.files) {
    const node = els.fileTemplate.content.cloneNode(true);
    node.querySelector(".file-icon").textContent = (extensionFor(file) || "FILE").toUpperCase().slice(0, 4);
    node.querySelector(".file-name").textContent = file.name;
    node.querySelector(".file-meta").textContent = `${readableSize(file.size)} • ${file.type || "unknown type"}`;
    els.fileList.append(node);
  }
}

function renderResults() {
  els.resultList.replaceChildren();
  for (const output of state.outputs) {
    const node = els.resultTemplate.content.cloneNode(true);
    node.querySelector(".result-name").textContent = output.name;
    node.querySelector(".result-meta").textContent = readableSize(output.blob.size);
    const link = node.querySelector(".download-link");
    link.href = output.url;
    link.download = output.name;
    els.resultList.append(node);
  }
}

function renderMatrix(term = "") {
  const needle = term.trim().toLowerCase();
  els.matrixGrid.replaceChildren();
  for (const [from, to, engine, note] of conversions) {
    const label = `${from} to ${to}`;
    if (needle && !`${label} ${engine} ${note}`.includes(needle)) continue;
    const item = document.createElement("article");
    item.className = `conversion ${engine}`;
    item.innerHTML = `<strong>${label.toUpperCase()}</strong><span>${engine}</span><p>${note}</p>`;
    els.matrixGrid.append(item);
  }
}

async function convertQueuedFiles() {
  if (!state.files.length) {
    setStatus("Add files first");
    return;
  }

  const target = normalizeFormat(els.toFormat.value);
  setStatus("Converting");

  for (const file of state.files) {
    const source = normalizeFormat(els.fromFormat.value === "auto" ? extensionFor(file) : els.fromFormat.value);
    try {
      const outputs = await convertFile(file, source, target);
      state.outputs.push(...outputs);
      renderResults();
    } catch (error) {
      state.outputs.push(makeTextOutput(file, "conversion-error.txt", error.message));
      renderResults();
    }
  }

  setStatus("Conversion complete");
}

async function convertFile(file, source, target) {
  if (isImage(source) && isCanvasImage(target)) {
    return [await convertImage(file, target)];
  }

  if (source === "csv" && target === "json") {
    return [makeBlobOutput(file, "json", JSON.stringify(csvToJson(await file.text()), null, 2), "application/json")];
  }

  if (source === "json" && target === "csv") {
    return [makeBlobOutput(file, "csv", jsonToCsv(JSON.parse(await file.text())), "text/csv")];
  }

  if (source === "txt" && target === "html") {
    return [makeBlobOutput(file, "html", textToHtml(await file.text()), "text/html")];
  }

  if (source === "html" && target === "txt") {
    return [makeBlobOutput(file, "txt", htmlToText(await file.text()), "text/plain")];
  }

  if (source === "txt" && target === "json") {
    return [makeBlobOutput(file, "json", JSON.stringify({ text: await file.text() }, null, 2), "application/json")];
  }

  if (source === "json" && target === "txt") {
    return [makeBlobOutput(file, "txt", JSON.stringify(JSON.parse(await file.text()), null, 2), "text/plain")];
  }

  const recipe = conversions.find(([from, to]) => from === source && to === target);
  if (recipe?.[2] === "engine") {
    throw new Error(`${source.toUpperCase()} to ${target.toUpperCase()} needs a bundled local conversion engine before it can run in this standalone app.`);
  }

  throw new Error(`${source.toUpperCase()} to ${target.toUpperCase()} is not implemented in the browser engine yet.`);
}

async function convertImage(file, target) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const mime = target === "jpeg" || target === "jpg" ? "image/jpeg" : `image/${target}`;
  const blob = await canvasToBlob(canvas, mime, 0.92);
  return outputFromBlob(file, target === "jpg" ? "jpeg" : target, blob);
}

function csvToJson(csv) {
  const rows = csv.trim().split(/\r?\n/).map(parseCsvLine);
  const headers = rows.shift() || [];
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function jsonToCsv(value) {
  const rows = Array.isArray(value) ? value : [value];
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return [headers, ...rows.map(row => headers.map(header => row[header] ?? ""))]
    .map(row => row.map(csvEscape).join(","))
    .join("\n");
}

function parseCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      field += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  out.push(field);
  return out;
}

function csvEscape(value) {
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replaceAll("\"", "\"\"")}"` : str;
}

function textToHtml(text) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Converted Text</title>
</head>
<body>
  <pre>${escapeHtml(text)}</pre>
</body>
</html>
`;
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body?.textContent?.trim() || "";
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function extensionFor(file) {
  return file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
}

function normalizeFormat(format) {
  return (format || "").toLowerCase().replace("jpg", "jpeg");
}

function isImage(format) {
  return ["png", "jpeg", "jpg", "webp", "bmp", "gif"].includes(format);
}

function isCanvasImage(format) {
  return ["png", "jpeg", "jpg", "webp"].includes(format);
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Canvas export failed.")), mime, quality);
  });
}

function makeBlobOutput(file, ext, content, type) {
  return outputFromBlob(file, ext, new Blob([content], { type }));
}

function makeTextOutput(file, name, message) {
  const stem = nameWithoutExtension(file.name);
  const blob = new Blob([message], { type: "text/plain" });
  return {
    name: `${stem}-${name}`,
    blob,
    url: URL.createObjectURL(blob)
  };
}

function outputFromBlob(file, ext, blob, literalName = false) {
  const stem = nameWithoutExtension(file.name);
  const name = literalName ? `${stem}-${ext}` : `${stem}.${ext}`;
  return { name, blob, url: URL.createObjectURL(blob) };
}

function nameWithoutExtension(name) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

function readableSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function setStatus(message) {
  els.engineStatus.textContent = message;
}

function downloadAll() {
  for (const output of state.outputs) {
    const link = document.createElement("a");
    link.href = output.url;
    link.download = output.name;
    link.click();
  }
}
