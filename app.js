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
  ...engineConversions(),
  ["doc", "docx", "planned", "Legacy binary DOC is not supported. Save as DOCX first."],
  ["xls", "xlsx", "planned", "Legacy binary XLS is not supported. Save as XLSX first."],
  ["ppt", "pptx", "planned", "Legacy binary PPT is not supported. Save as PPTX first."],
  ["pdf", "png", "planned", "Rendering PDF pages to images is not implemented."],
  ["mp4", "webm", "planned", "Native media transcoder is not implemented yet."],
  ["mp4", "mkv", "planned", "Native media transcoder is not implemented yet."],
  ["webm", "mp4", "planned", "Native media transcoder is not implemented yet."],
  ["wav", "mp3", "planned", "Native audio encoder is not implemented yet."],
  ["flac", "wav", "planned", "Native audio decoder is not implemented yet."]
];

// Conversions handled by the Bun server (src/convert.js keeps the same table).
function engineConversions() {
  const notes = {
    pdf: "Built-in PDF parser with layout analysis: headings, paragraphs, and tables.",
    docx: "Built-in DOCX reader: headings, lists, tables, and text boxes.",
    xlsx: "Built-in XLSX reader: every visible sheet, dates, and cached formula values.",
    pptx: "Built-in PPTX reader: slide titles, text, and tables in slide order.",
    txt: "Built-in writer with word wrapping and pagination.",
    csv: "Built-in table writer."
  };
  const table = {
    pdf: ["txt", "html", "docx", "xlsx", "pptx", "csv"],
    docx: ["txt", "html", "pdf", "pptx"],
    xlsx: ["csv", "json", "txt", "html", "pdf", "docx"],
    pptx: ["txt", "html", "pdf", "docx"],
    txt: ["docx", "pdf", "pptx"],
    csv: ["xlsx", "pdf", "docx", "html"]
  };
  return Object.entries(table).flatMap(([from, targets]) => targets.map(to => [from, to, "engine", notes[from]]));
}

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
    els.fromFormat.append(new Option(fmt.toUpperCase(), fmt));
  }
  updateTargets();
}

// Only offers output formats the selected input format can actually convert to.
function updateTargets() {
  const source = normalizeFormat(els.fromFormat.value);
  const previous = els.toFormat.value;
  let targets = formats.filter(fmt => fmt !== "auto" && fmt !== "jpg");
  if (source !== "auto") {
    const supported = conversions.filter(([from, , engine]) => from === source && engine !== "planned").map(([, to]) => to);
    if (isImage(source)) supported.push("png", "jpeg", "webp");
    targets = targets.filter(fmt => supported.includes(fmt) && fmt !== source);
  }
  els.toFormat.replaceChildren(...targets.map(fmt => new Option(fmt.toUpperCase(), fmt)));
  if (targets.includes(previous)) els.toFormat.value = previous;
  els.convertForm.querySelector("#convertButton").disabled = targets.length === 0;
}

function bindEvents() {
  els.pickButton.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", event => addFiles(event.target.files));
  els.clearButton.addEventListener("click", clearAll);
  els.swapButton.addEventListener("click", swapFormats);
  els.fromFormat.addEventListener("change", updateTargets);
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
    const format = normalizeFormat(extensionFor(incoming[0]));
    els.fromFormat.value = formats.includes(format) ? format : "auto";
    updateTargets();
  }
  renderFiles();
}

function clearAll() {
  state.files = [];
  state.outputs.forEach(output => output.url && URL.revokeObjectURL(output.url));
  state.outputs = [];
  els.fileInput.value = "";
  renderFiles();
  renderResults();
  setStatus("Local engines ready");
}

function swapFormats() {
  const from = els.fromFormat.value;
  const to = els.toFormat.value;
  if (!to) return;
  els.fromFormat.value = to;
  updateTargets();
  if ([...els.toFormat.options].some(option => option.value === from)) els.toFormat.value = from;
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
    const link = node.querySelector(".download-link");
    if (output.error) {
      node.querySelector(".result-row").classList.add("failed");
      node.querySelector(".result-meta").textContent = output.error;
      link.remove();
    } else {
      node.querySelector(".result-meta").textContent = readableSize(output.blob.size);
      link.href = output.url;
      link.download = output.name;
    }
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
  if (!target) {
    setStatus("Choose an output format");
    return;
  }
  setStatus("Converting");
  let failures = 0;

  for (const file of state.files) {
    const source = normalizeFormat(els.fromFormat.value === "auto" ? extensionFor(file) : els.fromFormat.value);
    try {
      const outputs = await convertFile(file, source, target);
      state.outputs.push(...outputs);
    } catch (error) {
      failures += 1;
      state.outputs.push({ name: file.name, error: error.message || "Conversion failed." });
    }
    renderResults();
  }

  setStatus(failures ? `Finished with ${failures} error${failures === 1 ? "" : "s"}` : "Conversion complete");
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
  if (recipe?.[2] === "planned") {
    throw new Error(recipe[3]);
  }
  if (recipe?.[2] === "engine" || !formats.includes(source)) {
    // The server also inspects the file content, so unknown extensions are sent as-is.
    return convertOnServer(file, source, target);
  }

  throw new Error(`${source.toUpperCase()} to ${target.toUpperCase()} is not supported.`);
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
  const value = (format || "").toLowerCase();
  return { jpg: "jpeg", htm: "html", xlsm: "xlsx", docm: "docx", pptm: "pptx" }[value] || value;
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

async function convertOnServer(file, source, target) {
  const formData = new FormData();
  formData.set("file", file);
  formData.set("source", source);
  formData.set("target", target);

  const response = await fetch("/api/convert", {
    method: "POST",
    body: formData
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The conversion server did not return a valid response. Is `bun run start` still running?");
  }
  if (!response.ok) {
    throw new Error(payload.error || "Local engine conversion failed.");
  }
  return payload.outputs.map(output => {
    const blob = base64ToBlob(output.data, output.type);
    return {
      name: output.name,
      blob,
      url: URL.createObjectURL(blob)
    };
  });
}

function base64ToBlob(data, type) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
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
    if (output.error) continue;
    const link = document.createElement("a");
    link.href = output.url;
    link.download = output.name;
    link.click();
  }
}
