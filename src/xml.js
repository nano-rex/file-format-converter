// Small XML reader for OpenXML parts. Elements are matched by local name,
// so namespace prefixes chosen by the producing application do not matter.

const tokenPattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
const attrPattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(xml) {
  const root = { name: "#root", local: "#root", attrs: {}, children: [] };
  const stack = [root];
  if (!xml) return root;

  for (const match of xml.matchAll(tokenPattern)) {
    const parent = stack[stack.length - 1];
    if (match[1] !== undefined) {
      parent.children.push({ local: "#text", text: match[1] });
    } else if (match[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (match[3] !== undefined) {
      const node = { name: match[3], local: localName(match[3]), attrs: parseAttrs(match[4]), children: [] };
      parent.children.push(node);
      if (!match[5]) stack.push(node);
    } else if (match[6] !== undefined) {
      parent.children.push({ local: "#text", text: unescapeXml(match[6]) });
    }
  }
  return root;
}

function parseAttrs(source) {
  const attrs = {};
  if (!source) return attrs;
  for (const match of source.matchAll(attrPattern)) {
    const value = unescapeXml(match[2] ?? match[3] ?? "");
    attrs[match[1]] = value;
    const local = localName(match[1]);
    if (!(local in attrs)) attrs[local] = value;
  }
  return attrs;
}

function localName(name) {
  const index = name.indexOf(":");
  return index < 0 ? name : name.slice(index + 1);
}

export function child(node, local) {
  if (!node) return undefined;
  for (const item of node.children) {
    if (item.local === local) return item;
  }
  return undefined;
}

export function kids(node, local) {
  if (!node) return [];
  return node.children.filter(item => item.local === local);
}

// Depth-first search for the first descendant with the given local name.
export function find(node, local) {
  if (!node || !node.children) return undefined;
  for (const item of node.children) {
    if (item.local === local) return item;
    const nested = find(item, local);
    if (nested) return nested;
  }
  return undefined;
}

export function findAll(node, local, out = []) {
  if (!node || !node.children) return out;
  for (const item of node.children) {
    if (item.local === local) out.push(item);
    else findAll(item, local, out);
  }
  return out;
}

export function textOf(node) {
  if (!node) return "";
  if (node.local === "#text") return node.text;
  let out = "";
  for (const item of node.children) out += textOf(item);
  return out;
}

export function unescapeXml(value) {
  if (!value.includes("&")) return value;
  return value.replaceAll(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" }[entity];
  });
}

// Characters outside the XML 1.0 range make Office report the file as corrupt.
export function escapeXml(value) {
  return String(value ?? "")
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replaceAll(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

// Resolves a relationship target against the part that owns the .rels file.
export function resolveTarget(basePart, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = basePart.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}

export function readRels(xml) {
  const rels = new Map();
  for (const rel of findAll(parseXml(xml), "Relationship")) {
    rels.set(rel.attrs.Id, { target: rel.attrs.Target || "", type: rel.attrs.Type || "", external: rel.attrs.TargetMode === "External" });
  }
  return rels;
}
