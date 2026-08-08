import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

const publicDir = new URL(".", import.meta.url);
const port = Number(Bun.env.PORT || 3000);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/convert") {
      return convertRequest(request);
    }

    return serveStatic(url.pathname);
  }
});

console.log(`File Format Converter running at http://localhost:${port}`);

async function convertRequest(request) {
  const form = await request.formData();
  const file = form.get("file");
  const source = normalizeFormat(String(form.get("source") || ""));
  const target = normalizeFormat(String(form.get("target") || ""));

  if (!(file instanceof File)) {
    return jsonResponse({ error: "Missing uploaded file." }, 400);
  }

  const workDir = join(tmpdir(), `file-format-converter-${crypto.randomUUID()}`);
  const inputPath = join(workDir, safeName(file.name, source));

  try {
    await mkdir(workDir, { recursive: true });
    await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));
    const outputs = await convertWithLocalEngine(inputPath, file.name, source, target, workDir);
    return jsonResponse({ outputs: await encodeOutputs(outputs) });
  } catch (error) {
    return jsonResponse({ error: error.message || "Conversion failed." }, 500);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function convertWithLocalEngine(inputPath, originalName, source, target, workDir) {
  if (source === "pdf" && (target === "png" || target === "jpeg")) {
    return pdfToImages(inputPath, originalName, target, workDir);
  }

  if (source === "pdf" && target === "txt") {
    const output = join(workDir, `${stem(originalName)}.txt`);
    await run("pdftotext", ["-layout", inputPath, output]);
    return [{ path: output, name: basename(output), type: "text/plain" }];
  }

  if (source === "pdf" && target === "docx") {
    const textPath = join(workDir, `${stem(originalName)}.txt`);
    await run("pdftotext", ["-layout", inputPath, textPath]);
    return officeConvert(textPath, originalName, "docx", workDir);
  }

  if (source === "pdf" && target === "xlsx") {
    const textPath = join(workDir, `${stem(originalName)}.txt`);
    const csvPath = join(workDir, `${stem(originalName)}.csv`);
    await run("pdftotext", ["-layout", inputPath, textPath]);
    await writeFile(csvPath, textToCsv(await readFile(textPath, "utf8")));
    return officeConvert(csvPath, originalName, "xlsx", workDir);
  }

  if (source === "pdf" && target === "pptx") {
    const images = await pdfToImages(inputPath, originalName, "png", workDir);
    return [await imagesToPptx(images, originalName, workDir)];
  }

  if (isOfficeSource(source) && isOfficeTarget(target)) {
    return officeConvert(inputPath, originalName, target, workDir);
  }

  if ((source === "xlsx" || source === "xls") && target === "json") {
    const [csv] = await officeConvert(inputPath, originalName, "csv", workDir);
    const jsonPath = join(workDir, `${stem(originalName)}.json`);
    await writeFile(jsonPath, JSON.stringify(csvToJson(await readFile(csv.path, "utf8")), null, 2));
    return [{ path: jsonPath, name: basename(jsonPath), type: "application/json" }];
  }

  if (isMediaSource(source) && isMediaTarget(target)) {
    return mediaConvert(inputPath, originalName, target, workDir);
  }

  throw new Error(`${source.toUpperCase()} to ${target.toUpperCase()} is not supported by the local engine yet.`);
}

async function pdfToImages(inputPath, originalName, target, workDir) {
  const outDir = join(workDir, "pdf-pages");
  const prefix = join(outDir, "page");
  const flag = target === "jpeg" ? "-jpeg" : "-png";
  const ext = target === "jpeg" ? "jpg" : "png";
  await mkdir(outDir, { recursive: true });
  await run("pdftoppm", ["-r", "160", flag, inputPath, prefix]);
  const files = (await readdir(outDir))
    .filter(name => name.endsWith(`.${ext}`))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return files.map((name, index) => ({
    path: join(outDir, name),
    name: `${stem(originalName)}-page-${String(index + 1).padStart(2, "0")}.${target}`,
    type: target === "jpeg" ? "image/jpeg" : "image/png"
  }));
}

async function officeConvert(inputPath, originalName, target, workDir) {
  const outDir = join(workDir, "office-output");
  const profileDir = join(workDir, "libreoffice-profile");
  await mkdir(outDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await run("soffice", [
    `-env:UserInstallation=file://${profileDir}`,
    "--headless",
    "--nologo",
    "--nofirststartwizard",
    "--convert-to",
    target,
    "--outdir",
    outDir,
    inputPath
  ], { HOME: workDir });

  const output = await findConvertedFile(outDir, target);
  return [{
    path: output,
    name: `${stem(originalName)}.${normalizeOutputExtension(target)}`,
    type: mimeFor(target)
  }];
}

async function mediaConvert(inputPath, originalName, target, workDir) {
  const output = join(workDir, `${stem(originalName)}.${target}`);
  await run("ffmpeg", ["-y", "-i", inputPath, output]);
  return [{ path: output, name: basename(output), type: mimeFor(target) }];
}

async function imagesToPptx(images, originalName, workDir) {
  const root = join(workDir, "pptx-package");
  const output = join(workDir, `${stem(originalName)}.pptx`);
  await mkdir(join(root, "_rels"), { recursive: true });
  await mkdir(join(root, "docProps"), { recursive: true });
  await mkdir(join(root, "ppt", "_rels"), { recursive: true });
  await mkdir(join(root, "ppt", "slides", "_rels"), { recursive: true });
  await mkdir(join(root, "ppt", "media"), { recursive: true });

  await writeFile(join(root, "[Content_Types].xml"), pptxContentTypes(images.length));
  await writeFile(join(root, "_rels", ".rels"), rootRels());
  await writeFile(join(root, "docProps", "app.xml"), appProps(images.length));
  await writeFile(join(root, "docProps", "core.xml"), coreProps(originalName));
  await writeFile(join(root, "ppt", "presentation.xml"), presentationXml(images.length));
  await writeFile(join(root, "ppt", "_rels", "presentation.xml.rels"), presentationRels(images.length));

  for (let index = 0; index < images.length; index += 1) {
    const slideNumber = index + 1;
    await writeFile(join(root, "ppt", "media", `image${slideNumber}.png`), await readFile(images[index].path));
    await writeFile(join(root, "ppt", "slides", `slide${slideNumber}.xml`), slideXml(slideNumber));
    await writeFile(join(root, "ppt", "slides", "_rels", `slide${slideNumber}.xml.rels`), slideRels(slideNumber));
  }

  await run("zip", ["-qr", output, "."], {}, root);
  return {
    path: output,
    name: `${stem(originalName)}.pptx`,
    type: mimeFor("pptx")
  };
}

async function run(command, args, extraEnv = {}, cwd) {
  const process = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...extraEnv },
    cwd
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} failed: ${(stderr || stdout).trim()}`);
  }
}

function pptxContentTypes(count) {
  const slides = Array.from({ length: count }, (_, index) => (
    `  <Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  )).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slides}
</Types>
`;
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`;
}

function appProps(count) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>File Format Converter</Application>
  <Slides>${count}</Slides>
</Properties>
`;
}

function coreProps(originalName) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(stem(originalName))}</dc:title>
  <dc:creator>File Format Converter</dc:creator>
  <cp:lastModifiedBy>File Format Converter</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>
`;
}

function presentationXml(count) {
  const slideIds = Array.from({ length: count }, (_, index) => {
    const id = 256 + index;
    return `    <p:sldId id="${id}" r:id="rId${index + 1}"/>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
${slideIds}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>
`;
}

function presentationRels(count) {
  const rels = Array.from({ length: count }, (_, index) => (
    `  <Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
  )).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
</Relationships>
`;
}

function slideXml(slideNumber) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="2" name="Page ${slideNumber}"/>
          <p:cNvPicPr/>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rId1"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm>
            <a:off x="0" y="0"/>
            <a:ext cx="12192000" cy="6858000"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
`;
}

function slideRels(slideNumber) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${slideNumber}.png"/>
</Relationships>
`;
}

async function findConvertedFile(outDir, target) {
  const ext = `.${normalizeOutputExtension(target)}`;
  const files = await readdir(outDir);
  const match = files.find(name => name.toLowerCase().endsWith(ext));
  if (!match) {
    throw new Error(`Converter did not produce a ${target.toUpperCase()} file.`);
  }
  return join(outDir, match);
}

async function encodeOutputs(outputs) {
  return Promise.all(outputs.map(async output => ({
    name: output.name,
    type: output.type,
    data: Buffer.from(await readFile(output.path)).toString("base64")
  })));
}

function serveStatic(pathname) {
  const cleanPath = pathname === "/" ? "index.html" : pathname.slice(1);
  if (cleanPath.includes("..")) return new Response("Not found", { status: 404 });
  const file = Bun.file(new URL(cleanPath, publicDir));
  return new Response(file, {
    headers: { "content-type": mimeFor(extname(cleanPath).slice(1)) }
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function textToCsv(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.split(/\s{2,}|\t/).map(csvEscape).join(","))
    .join("\n");
}

function csvToJson(csv) {
  const rows = csv.trim().split(/\r?\n/).map(parseCsvLine);
  const headers = rows.shift() || [];
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
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

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function safeName(name, fallbackExt) {
  const base = basename(name).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  if (base.includes(".")) return base;
  return `${base || "input"}.${fallbackExt || "bin"}`;
}

function stem(name) {
  const base = basename(name);
  const index = base.lastIndexOf(".");
  return (index > 0 ? base.slice(0, index) : base).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeFormat(format) {
  return format.toLowerCase().replace("jpg", "jpeg");
}

function normalizeOutputExtension(format) {
  return format === "jpeg" ? "jpg" : format;
}

function isOfficeSource(format) {
  return ["doc", "docx", "odt", "rtf", "html", "txt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"].includes(format);
}

function isOfficeTarget(format) {
  return ["docx", "pdf", "html", "txt", "xlsx", "csv", "pptx"].includes(format);
}

function isMediaSource(format) {
  return ["mp4", "webm", "mkv", "mov", "mp3", "wav", "flac", "ogg"].includes(format);
}

function isMediaTarget(format) {
  return ["mp4", "webm", "mkv", "mov", "mp3", "wav", "flac", "ogg"].includes(format);
}

function mimeFor(format) {
  const type = normalizeFormat(format);
  return {
    html: "text/html",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    webp: "image/webp",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    css: "text/css",
    js: "text/javascript"
  }[type] || "application/octet-stream";
}
