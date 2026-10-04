import { createZip, readZip, zipText } from "./zip.js";
import { child, escapeXml, find, findAll, kids, parseXml, readRels, resolveTarget, textOf } from "./xml.js";
import { appPropsXml, corePropsXml, packageRels } from "./docx.js";

const emuPerPoint = 12700;

export function readPptx(buffer, title) {
  const entries = readZip(buffer);
  let presentationPath = "ppt/presentation.xml";
  for (const rel of readRels(zipText(entries, "_rels/.rels")).values()) {
    if (rel.type.endsWith("/officeDocument")) presentationPath = resolveTarget("", rel.target);
  }
  if (!entries.has(presentationPath)) throw new Error("This file is not a PowerPoint presentation (ppt/presentation.xml is missing).");

  const presentation = parseXml(zipText(entries, presentationPath));
  const rels = readRels(zipText(entries, presentationPath.replace(/([^/]+)$/, "_rels/$1.rels")));
  const size = find(presentation, "sldSz");
  const width = size ? Number(size.attrs.cx) / emuPerPoint : 960;
  const height = size ? Number(size.attrs.cy) / emuPerPoint : 540;

  const pages = [];
  for (const slide of findAll(find(presentation, "sldIdLst"), "sldId")) {
    const relId = slide.attrs["r:id"] ?? Object.entries(slide.attrs).find(([key]) => key.endsWith(":id"))?.[1];
    const rel = rels.get(relId);
    if (!rel) continue;
    const path = resolveTarget(presentationPath, rel.target);
    if (!entries.has(path)) continue;
    const tree = find(parseXml(zipText(entries, path)), "spTree");
    const blocks = [];
    if (tree) readShapes(tree, blocks);
    // Titles first, then the remaining shapes from top to bottom.
    blocks.sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || a.order - b.order);
    pages.push({ name: `Slide ${pages.length + 1}`, width, height, blocks: blocks.map(({ order, title: _title, ...block }) => block) });
  }
  if (!pages.length) throw new Error("This presentation has no slides.");
  return { title, source: "pptx", pages };
}

function readShapes(tree, blocks, base = 0) {
  tree.children.forEach((node, index) => {
    const offset = find(child(node, "spPr") || child(node, "xfrm") || child(node, "grpSpPr"), "off");
    const y = offset ? Number(offset.attrs.y) || 0 : 0;
    const x = offset ? Number(offset.attrs.x) || 0 : 0;
    const order = base + y + x / 1e9 + index / 1e12;

    if (node.local === "sp") {
      const placeholder = find(child(node, "nvSpPr"), "ph");
      const kind = placeholder?.attrs.type || "";
      if (["sldNum", "dt", "ftr", "hdr"].includes(kind)) return;
      const isTitle = kind === "title" || kind === "ctrTitle";
      for (const paragraph of kids(child(node, "txBody"), "p")) {
        const text = paragraphText(paragraph);
        if (!text.trim()) continue;
        if (isTitle) blocks.push({ type: "heading", level: 1, text: text.trim(), order, title: true });
        else blocks.push({ type: "paragraph", text, order });
      }
    } else if (node.local === "graphicFrame") {
      const table = find(node, "tbl");
      if (!table) return;
      const rows = kids(table, "tr").map(row => kids(row, "tc").map(cell => (
        kids(child(cell, "txBody"), "p").map(paragraphText).join("\n").trim()
      )));
      if (rows.length) blocks.push({ type: "table", rows, order });
    } else if (node.local === "grpSp") {
      readShapes(node, blocks, base);
    } else if (node.local === "AlternateContent") {
      const branch = child(node, "Choice") || child(node, "Fallback");
      if (branch) readShapes(branch, blocks, base);
    }
  });
}

function paragraphText(paragraph) {
  let out = "";
  for (const item of paragraph.children) {
    if (item.local === "r" || item.local === "fld") out += textOf(child(item, "t"));
    else if (item.local === "br") out += "\n";
  }
  const level = Number(child(paragraph, "pPr")?.attrs.lvl || 0);
  return "  ".repeat(level) + out;
}

// ---------------------------------------------------------------------------
// Writer

export function writePptx(doc) {
  const positioned = doc.pages.some(page => page.items);
  const first = doc.pages[0] || {};
  const width = positioned ? clampSlide((first.width || 612) * emuPerPoint) : 12192000;
  const height = positioned ? clampSlide((first.height || 792) * emuPerPoint) : 6858000;
  const slides = positioned
    ? doc.pages.map(page => positionedSlide(page, width, height))
    : flowSlides(doc, width, height);
  if (!slides.length) slides.push(slideXml(""));

  const slideType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ["_rels/.rels", packageRels("ppt/presentation.xml")],
    ["docProps/core.xml", corePropsXml(doc.title)],
    ["docProps/app.xml", appPropsXml()],
    ["ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${slideType}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${slideType}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${slideType}/theme" Target="theme/theme1.xml"/>${slides.map((_, index) => `<Relationship Id="rId${index + 3}" Type="${slideType}/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`],
    ["ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${slideType}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${slideType}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${slideType}/theme" Target="../theme/theme1.xml"/></Relationships>`],
    ["ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${slideType}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank">${emptyTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${slideType}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`],
    ["ppt/theme/theme1.xml", themeXml()]
  ];
  slides.forEach((xml, index) => {
    files.push([`ppt/slides/slide${index + 1}.xml`, xml]);
    files.push([`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${slideType}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`]);
  });
  return createZip(files);
}

// PowerPoint accepts slide sides between 1 and 56 inches.
function clampSlide(value) {
  return Math.round(Math.min(51206400, Math.max(914400, value)));
}

const emptyTree = "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree>";

function slideXml(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${emptyTree.replace("</p:spTree>", `${shapes}</p:spTree>`)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function textBox(id, x, y, cx, cy, paragraphs, wrap) {
  const body = paragraphs.map(({ text, size, bold }) => {
    const properties = `<a:rPr lang="en-US" sz="${Math.max(100, Math.min(400000, Math.round(size * 100)))}"${bold ? " b=\"1\"" : ""} dirty="0"/>`;
    const runs = String(text).split("\n").map(line => `<a:r>${properties}<a:t>${escapeXml(line.replaceAll("\t", "    "))}</a:t></a:r>`).join("<a:br/>");
    return `<a:p>${runs}</a:p>`;
  }).join("") || "<a:p/>";
  const bodyProperties = wrap
    ? "<a:bodyPr wrap=\"square\" rtlCol=\"0\"><a:normAutofit/></a:bodyPr>"
    : "<a:bodyPr wrap=\"none\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" rtlCol=\"0\"><a:noAutofit/></a:bodyPr>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.max(1, Math.round(cx))}" cy="${Math.max(1, Math.round(cy))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody>${bodyProperties}<a:lstStyle/>${body}</p:txBody></p:sp>`;
}

// PDF pages keep their layout: every text segment becomes a text box at its original position.
function positionedSlide(page, slideWidth, slideHeight) {
  const scaleX = slideWidth / ((page.width || 612) * emuPerPoint);
  const scaleY = slideHeight / ((page.height || 792) * emuPerPoint);
  const scale = Math.min(scaleX, scaleY);
  let id = 2;
  const shapes = (page.items || []).map(item => {
    const size = item.size * scale;
    const x = item.x * emuPerPoint * scale;
    const y = (item.y - item.size * 0.93) * emuPerPoint * scale;
    const box = textBox(id, Math.max(0, x), Math.max(0, y), (item.width * scale + size) * emuPerPoint, size * 1.25 * emuPerPoint,
      [{ text: item.text, size, bold: item.bold }], false);
    id += 1;
    return box;
  }).join("");
  return slideXml(shapes);
}

function flowSlides(doc, width, height) {
  const slides = [];
  const margin = 457200;
  const bodyTop = 1371600;
  const bodyHeight = height - bodyTop - margin;
  const emit = (title, paragraphs, table) => {
    let shapes = textBox(2, margin, 304800, width - 2 * margin, 914400, [{ text: title, size: 28, bold: true }], true);
    if (table) shapes += tableFrame(3, margin, bodyTop, width - 2 * margin, table);
    else if (paragraphs.length) shapes += textBox(3, margin, bodyTop, width - 2 * margin, bodyHeight, paragraphs, true);
    slides.push(slideXml(shapes));
  };

  for (const page of doc.pages) {
    let title = page.name || doc.title || "";
    let pending = [];
    let used = 0;
    let emitted = false;
    const flush = () => {
      if (pending.length) {
        emit(title, pending, null);
        emitted = true;
      }
      pending = [];
      used = 0;
    };
    for (const block of page.blocks) {
      if (block.type === "heading") {
        flush();
        title = block.text;
        emitted = false;
      } else if (block.type === "table") {
        flush();
        for (let start = 0; start < block.rows.length; start += 12) emit(title, [], block.rows.slice(start, start + 12));
        emitted = true;
      } else {
        const cost = block.text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 80)), 0);
        if (used + cost > 12 && pending.length) flush();
        pending.push({ text: block.text, size: 18, bold: block.bold });
        used += cost;
      }
    }
    flush();
    if (!emitted) emit(title, [], null);
  }
  return slides;
}

function tableFrame(id, x, y, width, rows) {
  const columns = Math.max(1, ...rows.map(row => row.length));
  const columnWidth = Math.floor(width / columns);
  const size = columns > 8 ? 900 : columns > 5 ? 1100 : 1400;
  const body = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columns }, (_, column) => {
      const text = String(row[column] ?? "");
      const runs = text.split("\n").map(line => `<a:r><a:rPr lang="en-US" sz="${size}"${rowIndex === 0 ? " b=\"1\"" : ""} dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r>`).join("<a:br/>");
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text ? runs : ""}</a:p></a:txBody><a:tcPr/></a:tc>`;
    }).join("");
    return `<a:tr h="370840">${cells}</a:tr>`;
  }).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${columnWidth * columns}" cy="${370840 * rows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${`<a:gridCol w="${columnWidth}"/>`.repeat(columns)}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function themeXml() {
  const colors = { dk2: "44546A", lt2: "E7E6E6", accent1: "4472C4", accent2: "ED7D31", accent3: "A5A5A5", accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47", hlink: "0563C1", folHlink: "954F72" };
  const fill = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
  const fonts = name => `<a:latin typeface="${name}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>${Object.entries(colors).map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join("")}</a:clrScheme><a:fontScheme name="Office"><a:majorFont>${fonts("Calibri Light")}</a:majorFont><a:minorFont>${fonts("Calibri")}</a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map(line => `<a:ln w="${line}">${fill}</a:ln>`).join("")}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}
