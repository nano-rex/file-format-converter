// Native PDF reader: cross-reference tables and streams, object streams,
// stream filters, the standard security handler, and font decoding. It
// produces positioned text runs for each page; pdf-layout.js turns those
// into lines, paragraphs, and tables.

import { constants, inflateRawSync, inflateSync } from "node:zlib";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { helveticaWidths } from "./util.js";

export class Name {
  constructor(name) {
    this.name = name;
  }
}

export class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}

class Op {
  constructor(name) {
    this.name = name;
  }
}

class Stream {
  constructor(dict, start) {
    this.dict = dict;
    this.start = start;
  }
}

const EOF = Symbol("eof");
const CLOSE_ARRAY = Symbol("]");
const CLOSE_DICT = Symbol(">>");

const whitespace = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) whitespace[code] = 1;
const delimiter = new Uint8Array(256);
for (const char of "()<>[]{}/%") delimiter[char.charCodeAt(0)] = 1;

class Lexer {
  constructor(buf, pos = 0, content = false) {
    this.buf = buf;
    this.pos = pos;
    this.content = content;
  }

  skipWhitespace() {
    const { buf } = this;
    while (this.pos < buf.length) {
      const byte = buf[this.pos];
      if (whitespace[byte]) {
        this.pos += 1;
      } else if (byte === 0x25) {
        while (this.pos < buf.length && buf[this.pos] !== 10 && buf[this.pos] !== 13) this.pos += 1;
      } else {
        break;
      }
    }
  }

  readObject() {
    this.skipWhitespace();
    const { buf } = this;
    if (this.pos >= buf.length) return EOF;
    const byte = buf[this.pos];

    if (byte === 0x2f) return this.readName();
    if (byte === 0x28) return this.readLiteralString();
    if (byte === 0x3c) {
      if (buf[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.readDict();
      }
      return this.readHexString();
    }
    if (byte === 0x3e) {
      this.pos += buf[this.pos + 1] === 0x3e ? 2 : 1;
      return CLOSE_DICT;
    }
    if (byte === 0x5b) {
      this.pos += 1;
      const items = [];
      for (;;) {
        const item = this.readObject();
        if (item === CLOSE_ARRAY || item === EOF) break;
        if (item === CLOSE_DICT) continue;
        items.push(item);
      }
      return items;
    }
    if (byte === 0x5d) {
      this.pos += 1;
      return CLOSE_ARRAY;
    }
    if (byte === 0x7b || byte === 0x7d || byte === 0x29) {
      this.pos += 1;
      return new Op(String.fromCharCode(byte));
    }
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      return this.readNumber();
    }

    const start = this.pos;
    while (this.pos < buf.length && !whitespace[buf[this.pos]] && !delimiter[buf[this.pos]]) this.pos += 1;
    const word = buf.latin1Slice(start, this.pos);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return new Op(word);
  }

  readNumber() {
    const { buf } = this;
    const start = this.pos;
    let integer = true;
    while (this.pos < buf.length) {
      const byte = buf[this.pos];
      if (byte >= 0x30 && byte <= 0x39) {
        this.pos += 1;
      } else if (byte === 0x2e || byte === 0x2b || byte === 0x2d) {
        if (byte === 0x2e) integer = false;
        this.pos += 1;
      } else {
        break;
      }
    }
    const value = Number.parseFloat(buf.latin1Slice(start, this.pos).replace(/^([+-])[+-]+/, "$1")) || 0;
    if (this.content || !integer || value < 0) return value;

    // "12 0 R" is an indirect reference; look ahead without consuming.
    const saved = this.pos;
    this.skipWhitespace();
    const genStart = this.pos;
    while (this.pos < buf.length && buf[this.pos] >= 0x30 && buf[this.pos] <= 0x39) this.pos += 1;
    if (this.pos > genStart) {
      const gen = Number.parseInt(buf.latin1Slice(genStart, this.pos), 10);
      this.skipWhitespace();
      const next = buf[this.pos + 1];
      if (buf[this.pos] === 0x52 && (this.pos + 1 >= buf.length || whitespace[next] || delimiter[next])) {
        this.pos += 1;
        return new Ref(value, gen);
      }
    }
    this.pos = saved;
    return value;
  }

  readName() {
    const { buf } = this;
    this.pos += 1;
    const start = this.pos;
    while (this.pos < buf.length && !whitespace[buf[this.pos]] && !delimiter[buf[this.pos]]) this.pos += 1;
    let name = buf.latin1Slice(start, this.pos);
    if (name.includes("#")) {
      name = name.replaceAll(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
    return new Name(name);
  }

  readLiteralString() {
    const { buf } = this;
    this.pos += 1;
    const out = [];
    let depth = 1;
    while (this.pos < buf.length) {
      let byte = buf[this.pos];
      this.pos += 1;
      if (byte === 0x5c) {
        byte = buf[this.pos];
        this.pos += 1;
        if (byte === 0x6e) out.push(10);
        else if (byte === 0x72) out.push(13);
        else if (byte === 0x74) out.push(9);
        else if (byte === 0x62) out.push(8);
        else if (byte === 0x66) out.push(12);
        else if (byte >= 0x30 && byte <= 0x37) {
          let value = byte - 0x30;
          for (let count = 0; count < 2; count += 1) {
            const next = buf[this.pos];
            if (next >= 0x30 && next <= 0x37) {
              value = value * 8 + next - 0x30;
              this.pos += 1;
            } else {
              break;
            }
          }
          out.push(value & 0xff);
        } else if (byte === 13) {
          if (buf[this.pos] === 10) this.pos += 1;
        } else if (byte !== 10 && byte !== undefined) {
          out.push(byte);
        }
      } else if (byte === 0x28) {
        depth += 1;
        out.push(byte);
      } else if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) break;
        out.push(byte);
      } else {
        out.push(byte);
      }
    }
    return Buffer.from(out);
  }

  readHexString() {
    const { buf } = this;
    this.pos += 1;
    const out = [];
    let high = -1;
    while (this.pos < buf.length) {
      const byte = buf[this.pos];
      this.pos += 1;
      if (byte === 0x3e) break;
      const digit = hexValue(byte);
      if (digit < 0) continue;
      if (high < 0) {
        high = digit;
      } else {
        out.push(high * 16 + digit);
        high = -1;
      }
    }
    if (high >= 0) out.push(high * 16);
    return Buffer.from(out);
  }

  readDict() {
    const dict = Object.create(null);
    for (;;) {
      const key = this.readObject();
      if (key === CLOSE_DICT || key === EOF) break;
      if (!(key instanceof Name)) continue;
      const value = this.readObject();
      if (value === CLOSE_DICT || value === EOF) break;
      if (value === CLOSE_ARRAY) continue;
      dict[key.name] = value;
    }
    return dict;
  }
}

function hexValue(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

function isDict(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) &&
    !(value instanceof Name) && !(value instanceof Ref) && !(value instanceof Stream) && !(value instanceof Op);
}

function nameOf(value) {
  return value instanceof Name ? value.name : "";
}

export class PdfDocument {
  constructor(buffer) {
    const header = buffer.indexOf("%PDF-");
    if (header < 0 || header > 4096) throw new Error("This file is not a PDF document.");
    this.buf = header > 0 ? buffer.subarray(header) : buffer;
    this.xref = new Map();
    this.cache = new Map();
    this.objectStreams = new Map();
    this.fonts = new Map();
    this.trailer = Object.create(null);
    this.crypt = null;
    this.rebuilt = false;
    this.unmappedGlyphs = 0;

    try {
      this.readXrefChain();
      if (!isDict(this.resolve(this.trailer.Root))) throw new Error("missing catalog");
    } catch {
      this.rebuild();
    }
    this.setupEncryption();
    if (!isDict(this.resolve(this.trailer.Root))) {
      if (!this.rebuilt) this.rebuild();
      if (!isDict(this.resolve(this.trailer.Root))) throw new Error("This PDF is damaged: its document catalog could not be found.");
    }
  }

  readXrefChain() {
    const { buf } = this;
    const tail = buf.lastIndexOf("startxref");
    if (tail < 0) throw new Error("missing startxref");
    const lexer = new Lexer(buf, tail + 9, true);
    const pending = [lexer.readObject()];
    const visited = new Set();
    while (pending.length) {
      const offset = pending.shift();
      if (typeof offset !== "number" || visited.has(offset) || offset >= buf.length) continue;
      visited.add(offset);
      const dict = this.readXrefSection(offset);
      for (const key of Object.keys(dict)) {
        if (!(key in this.trailer)) this.trailer[key] = dict[key];
      }
      if (typeof dict.XRefStm === "number") pending.push(dict.XRefStm);
      if (typeof dict.Prev === "number") pending.push(dict.Prev);
    }
  }

  readXrefSection(offset) {
    const { buf } = this;
    const lexer = new Lexer(buf, offset, true);
    lexer.skipWhitespace();
    if (buf.latin1Slice(lexer.pos, lexer.pos + 4) === "xref") {
      lexer.pos += 4;
      for (;;) {
        const first = lexer.readObject();
        if (first instanceof Op) {
          if (first.name !== "trailer") throw new Error("bad xref table");
          break;
        }
        const count = lexer.readObject();
        if (typeof first !== "number" || typeof count !== "number") throw new Error("bad xref table");
        for (let index = 0; index < count; index += 1) {
          const position = lexer.readObject();
          const gen = lexer.readObject();
          const kind = lexer.readObject();
          if (typeof position !== "number" || !(kind instanceof Op)) throw new Error("bad xref entry");
          const num = first + index;
          if (this.xref.has(num)) continue;
          this.xref.set(num, kind.name === "n" ? { offset: position, gen } : { free: true });
        }
      }
      const dict = new Lexer(buf, lexer.pos).readObject();
      if (!isDict(dict)) throw new Error("bad trailer");
      return dict;
    }

    const stream = this.parseIndirect(offset).value;
    if (!(stream instanceof Stream)) throw new Error("bad xref stream");
    const { dict } = stream;
    const widths = this.resolve(dict.W);
    if (!Array.isArray(widths)) throw new Error("bad xref stream");
    const data = this.streamData(stream, 0, 0, true);
    const size = this.resolve(dict.Size) || 0;
    const index = this.resolve(dict.Index) || [0, size];
    const [w0, w1, w2] = widths;
    const rowSize = w0 + w1 + w2;
    let pos = 0;
    for (let section = 0; section + 1 < index.length; section += 2) {
      for (let item = 0; item < index[section + 1]; item += 1) {
        if (pos + rowSize > data.length) break;
        const type = w0 ? readUInt(data, pos, w0) : 1;
        const field1 = readUInt(data, pos + w0, w1);
        const field2 = readUInt(data, pos + w0 + w1, w2);
        pos += rowSize;
        const num = index[section] + item;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { offset: field1, gen: field2 });
        else if (type === 2) this.xref.set(num, { stream: field1, index: field2 });
        else this.xref.set(num, { free: true });
      }
    }
    return dict;
  }

  // Recovery path for files with a broken or missing cross-reference table.
  rebuild() {
    this.rebuilt = true;
    this.xref = new Map();
    this.cache = new Map();
    this.objectStreams = new Map();
    const { buf } = this;
    const text = buf.latin1Slice(0, buf.length);
    const offsets = [];
    for (const match of text.matchAll(/(?:^|[\r\n\s>])(\d{1,10})\s+(\d{1,5})\s+obj(?![a-zA-Z])/g)) {
      const offset = match.index + match[0].indexOf(match[1]);
      this.xref.set(Number(match[1]), { offset, gen: Number(match[2]) });
      offsets.push(Number(match[1]));
    }

    const trailer = Object.create(null);
    const merge = dict => {
      for (const key of Object.keys(dict)) trailer[key] = dict[key];
    };
    for (const match of text.matchAll(/trailer\s*<</g)) {
      try {
        const dict = new Lexer(buf, match.index + 7).readObject();
        if (isDict(dict)) merge(dict);
      } catch {
        // Ignore unreadable trailers; later ones may still be usable.
      }
    }

    for (const num of offsets) {
      let value;
      try {
        value = this.parseIndirect(this.xref.get(num).offset).value;
      } catch {
        continue;
      }
      if (value instanceof Stream) {
        value.num = num;
        value.gen = this.xref.get(num).gen;
        const type = nameOf(value.dict.Type);
        if (type === "XRef") {
          merge(value.dict);
        } else if (type === "ObjStm") {
          try {
            const count = this.loadObjectStream(num, value).length;
            for (let index = 0; index < count; index += 1) {
              const inner = this.objectStreams.get(num)[index].num;
              const current = this.xref.get(inner);
              if (!current || current.stream !== undefined) this.xref.set(inner, { stream: num, index });
            }
          } catch {
            // Encrypted or damaged object stream; skip it.
          }
        }
      } else if (isDict(value) && nameOf(value.Type) === "Catalog" && !trailer.Root) {
        trailer.Root = new Ref(num, 0);
      }
    }
    delete trailer.Prev;
    delete trailer.XRefStm;
    this.trailer = trailer;
  }

  parseIndirect(offset, expected = -1) {
    const lexer = new Lexer(this.buf, offset);
    let num = lexer.readObject();
    const gen = lexer.readObject();
    const keyword = lexer.readObject();
    let value;
    if (typeof num === "number" && keyword instanceof Op && keyword.name === "obj") {
      value = lexer.readObject();
    } else {
      // Some writers omit the "N G obj" header; accept a bare object at the offset.
      lexer.pos = offset;
      value = lexer.readObject();
      if (!isDict(value) && !Array.isArray(value)) throw new Error("bad object header");
      num = expected;
    }
    if (value === EOF || value === CLOSE_DICT || value === CLOSE_ARRAY || value instanceof Op) value = null;
    if (isDict(value)) {
      lexer.skipWhitespace();
      const { buf } = this;
      if (buf.latin1Slice(lexer.pos, lexer.pos + 6) === "stream") {
        let start = lexer.pos + 6;
        if (buf[start] === 13) start += 1;
        if (buf[start] === 10) start += 1;
        value = new Stream(value, start);
      }
    }
    return { num, gen: typeof gen === "number" ? gen : 0, value };
  }

  getObject(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const entry = this.xref.get(num);
    let value = null;
    if (entry && !entry.free) {
      if (entry.stream !== undefined) {
        const container = this.getObject(entry.stream);
        if (container instanceof Stream) {
          const items = this.loadObjectStream(entry.stream, container);
          const item = items[entry.index]?.num === num ? items[entry.index] : items.find(candidate => candidate.num === num);
          value = item ? item.read() : null;
        }
      } else {
        let parsed;
        try {
          parsed = this.parseIndirect(entry.offset, num);
          if (parsed.num !== num) throw new Error("object number mismatch");
        } catch {
          if (this.rebuilt) {
            this.cache.set(num, null);
            return null;
          }
          this.rebuild();
          return this.getObject(num);
        }
        value = parsed.value;
        if (value instanceof Stream) {
          value.num = num;
          value.gen = parsed.gen;
        }
        if (this.crypt && !(this.crypt.encryptNum === num)) {
          value = this.decryptStrings(value, num, parsed.gen);
        }
      }
    }
    this.cache.set(num, value);
    return value;
  }

  loadObjectStream(num, stream) {
    if (this.objectStreams.has(num)) return this.objectStreams.get(num);
    const data = this.streamData(stream);
    const count = this.resolve(stream.dict.N) || 0;
    const first = this.resolve(stream.dict.First) || 0;
    const header = new Lexer(data, 0, true);
    const items = [];
    for (let index = 0; index < count; index += 1) {
      const objectNum = header.readObject();
      const offset = header.readObject();
      if (typeof objectNum !== "number" || typeof offset !== "number") break;
      let cached;
      let done = false;
      items.push({
        num: objectNum,
        read() {
          if (!done) {
            const value = new Lexer(data, first + offset).readObject();
            cached = value === EOF || value === CLOSE_DICT || value === CLOSE_ARRAY || value instanceof Op ? null : value;
            done = true;
          }
          return cached;
        }
      });
    }
    this.objectStreams.set(num, items);
    return items;
  }

  resolve(value) {
    let current = value;
    for (let depth = 0; current instanceof Ref && depth < 32; depth += 1) {
      current = this.getObject(current.num);
    }
    return current instanceof Ref ? null : current ?? null;
  }

  streamData(stream, _num, _gen, skipCrypt = false) {
    if (stream.data) return stream.data;
    const { buf } = this;
    let length = this.resolve(stream.dict.Length);
    const marker = typeof length === "number" ? buf.latin1Slice(stream.start + length, stream.start + length + 32) : "";
    if (typeof length !== "number" || !/^\s*endstream/.test(marker)) {
      let end = buf.indexOf("endstream", stream.start);
      if (end < 0) end = buf.length;
      if (buf[end - 1] === 10) end -= 1;
      if (buf[end - 1] === 13) end -= 1;
      length = Math.max(0, end - stream.start);
    }
    let data = buf.subarray(stream.start, stream.start + length);

    let filters = this.resolve(stream.dict.Filter ?? stream.dict.F);
    let params = this.resolve(stream.dict.DecodeParms ?? stream.dict.DP);
    filters = filters === null ? [] : Array.isArray(filters) ? filters : [filters];
    params = Array.isArray(params) ? params : [params];

    const type = nameOf(stream.dict.Type);
    if (this.crypt && !skipCrypt && type !== "XRef" && stream.num !== undefined) {
      const identity = nameOf(this.resolve(filters[0])) === "Crypt" &&
        nameOf(this.resolve(params[0])?.Name || new Name("Identity")) === "Identity";
      const skipMetadata = type === "Metadata" && !this.crypt.encryptMetadata;
      if (!identity && !skipMetadata) data = this.crypt.decrypt(data, stream.num, stream.gen, true);
    }

    for (let index = 0; index < filters.length; index += 1) {
      const filter = nameOf(this.resolve(filters[index]));
      const parm = this.resolve(params[index]);
      if (filter === "FlateDecode" || filter === "Fl") data = applyPredictor(inflate(data), parm, this);
      else if (filter === "LZWDecode" || filter === "LZW") data = applyPredictor(lzwDecode(data, parm), parm, this);
      else if (filter === "ASCIIHexDecode" || filter === "AHx") data = asciiHexDecode(data);
      else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85Decode(data);
      else if (filter === "RunLengthDecode" || filter === "RL") data = runLengthDecode(data);
      else if (filter === "Crypt") continue;
      else break;
    }
    stream.data = data;
    return data;
  }

  decryptStrings(value, num, gen) {
    if (Buffer.isBuffer(value)) return this.crypt.decrypt(value, num, gen, false);
    if (Array.isArray(value)) return value.map(item => this.decryptStrings(item, num, gen));
    if (value instanceof Stream) {
      this.decryptStrings(value.dict, num, gen);
      return value;
    }
    if (isDict(value)) {
      for (const key of Object.keys(value)) value[key] = this.decryptStrings(value[key], num, gen);
    }
    return value;
  }

  setupEncryption() {
    const encryptRef = this.trailer.Encrypt;
    const dict = this.resolve(encryptRef);
    if (!isDict(dict)) return;
    if (nameOf(dict.Filter) !== "Standard") {
      throw new Error("This PDF is encrypted with a security handler that is not supported.");
    }
    const crypt = createCrypt(this, dict);
    if (!crypt) throw new Error("This PDF is password-protected. Remove the password before converting.");
    crypt.encryptNum = encryptRef instanceof Ref ? encryptRef.num : -1;
    // Objects parsed before the key was known may hold undecrypted strings.
    const keep = crypt.encryptNum >= 0 ? this.cache.get(crypt.encryptNum) : undefined;
    this.cache = new Map();
    this.objectStreams = new Map();
    if (keep !== undefined) this.cache.set(crypt.encryptNum, keep);
    this.crypt = crypt;
  }

  getPages() {
    const pages = [];
    const visited = new Set();
    const walk = (ref, inherited, depth) => {
      const node = this.resolve(ref);
      if (!isDict(node) || visited.has(node) || depth > 64) return;
      visited.add(node);
      const merged = { ...inherited };
      for (const key of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
        if (node[key] !== undefined) merged[key] = node[key];
      }
      const children = this.resolve(node.Kids);
      if (Array.isArray(children) && nameOf(node.Type) !== "Page") {
        for (const item of children) walk(item, merged, depth + 1);
      } else {
        pages.push({ dict: node, ...merged });
      }
    };
    const catalog = this.resolve(this.trailer.Root);
    walk(catalog.Pages, {}, 0);

    if (!pages.length) {
      // Damaged page tree: fall back to every page object in the file.
      for (const num of this.xref.keys()) {
        const node = this.getObject(num);
        if (isDict(node) && nameOf(node.Type) === "Page") pages.push({ dict: node, Resources: node.Resources, MediaBox: node.MediaBox, CropBox: node.CropBox, Rotate: node.Rotate });
      }
    }
    return pages;
  }

  getTitle() {
    const info = this.resolve(this.trailer.Info);
    const title = isDict(info) ? this.resolve(info.Title) : null;
    return Buffer.isBuffer(title) ? decodeTextString(title).trim() : "";
  }

  getFont(ref) {
    const key = ref instanceof Ref ? ref.num : ref;
    if (this.fonts.has(key)) return this.fonts.get(key);
    const dict = this.resolve(ref);
    const font = isDict(dict) ? new PdfFont(this, dict) : null;
    this.fonts.set(key, font);
    return font;
  }
}

function readUInt(data, pos, width) {
  let value = 0;
  for (let index = 0; index < width; index += 1) value = value * 256 + data[pos + index];
  return value;
}

function decodeTextString(bytes) {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  let out = "";
  for (const byte of bytes) out += winAnsi[byte];
  return out;
}

function utf16be(bytes) {
  let out = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    out += String.fromCharCode(bytes[index] * 256 + bytes[index + 1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stream filters

function inflate(data) {
  const options = { finishFlush: constants.Z_SYNC_FLUSH };
  try {
    return inflateSync(data, options);
  } catch {
    try {
      return inflateRawSync(data.subarray(2), options);
    } catch {
      try {
        return inflateRawSync(data, options);
      } catch {
        return Buffer.alloc(0);
      }
    }
  }
}

function applyPredictor(data, parm, doc) {
  if (!isDict(parm)) return data;
  const predictor = doc.resolve(parm.Predictor) || 1;
  if (predictor < 2) return data;
  const colors = doc.resolve(parm.Colors) || 1;
  const bits = doc.resolve(parm.BitsPerComponent) || 8;
  const columns = doc.resolve(parm.Columns) || 1;
  const pixel = Math.max(1, Math.ceil(colors * bits / 8));
  const rowSize = Math.ceil(colors * bits * columns / 8);

  if (predictor === 2) {
    if (bits !== 8) return data;
    const out = Buffer.from(data);
    for (let row = 0; row + rowSize <= out.length; row += rowSize) {
      for (let index = pixel; index < rowSize; index += 1) {
        out[row + index] = (out[row + index] + out[row + index - pixel]) & 0xff;
      }
    }
    return out;
  }

  const rows = Math.floor(data.length / (rowSize + 1));
  const out = Buffer.alloc(rows * rowSize);
  for (let row = 0; row < rows; row += 1) {
    const type = data[row * (rowSize + 1)];
    const source = row * (rowSize + 1) + 1;
    const target = row * rowSize;
    for (let index = 0; index < rowSize; index += 1) {
      const raw = data[source + index];
      const left = index >= pixel ? out[target + index - pixel] : 0;
      const up = row > 0 ? out[target - rowSize + index] : 0;
      const upLeft = row > 0 && index >= pixel ? out[target - rowSize + index - pixel] : 0;
      let value = raw;
      if (type === 1) value = raw + left;
      else if (type === 2) value = raw + up;
      else if (type === 3) value = raw + ((left + up) >> 1);
      else if (type === 4) {
        const estimate = left + up - upLeft;
        const distLeft = Math.abs(estimate - left);
        const distUp = Math.abs(estimate - up);
        const distUpLeft = Math.abs(estimate - upLeft);
        value = raw + (distLeft <= distUp && distLeft <= distUpLeft ? left : distUp <= distUpLeft ? up : upLeft);
      }
      out[target + index] = value & 0xff;
    }
  }
  return out;
}

function lzwDecode(data, parm) {
  const early = isDict(parm) && parm.EarlyChange === 0 ? 0 : 1;
  const out = [];
  let table = [];
  let width = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let previous = null;
  const reset = () => {
    table = [];
    for (let index = 0; index < 256; index += 1) table.push([index]);
    table.push(null, null);
    width = 9;
    previous = null;
  };
  reset();
  for (const byte of data) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= width) {
      const code = (bitBuffer >> (bitCount - width)) & ((1 << width) - 1);
      bitCount -= width;
      bitBuffer &= (1 << bitCount) - 1;
      if (code === 256) {
        reset();
        continue;
      }
      if (code === 257) return Buffer.from(out);
      let entry;
      if (code < table.length) {
        entry = table[code];
      } else if (previous) {
        entry = [...previous, previous[0]];
      } else {
        return Buffer.from(out);
      }
      if (!entry) return Buffer.from(out);
      for (const value of entry) out.push(value);
      if (previous) table.push([...previous, entry[0]]);
      previous = entry;
      const size = table.length + early;
      if (size >= 2048) width = 12;
      else if (size >= 1024) width = 11;
      else if (size >= 512) width = 10;
    }
  }
  return Buffer.from(out);
}

function asciiHexDecode(data) {
  const out = [];
  let high = -1;
  for (const byte of data) {
    if (byte === 0x3e) break;
    const digit = hexValue(byte);
    if (digit < 0) continue;
    if (high < 0) {
      high = digit;
    } else {
      out.push(high * 16 + digit);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16);
  return Buffer.from(out);
}

function ascii85Decode(data) {
  const out = [];
  let group = [];
  const flush = count => {
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    for (let index = 0; index < count; index += 1) out.push(bytes[index]);
    group = [];
  };
  let start = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) start = 2;
  for (let index = start; index < data.length; index += 1) {
    const byte = data[index];
    if (byte === 0x7e) break;
    if (whitespace[byte]) continue;
    if (byte === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) continue;
    group.push(byte - 0x21);
    if (group.length === 5) flush(4);
  }
  if (group.length > 1) flush(group.length - 1);
  return Buffer.from(out);
}

function runLengthDecode(data) {
  const out = [];
  let pos = 0;
  while (pos < data.length) {
    const length = data[pos];
    pos += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let index = 0; index <= length && pos < data.length; index += 1, pos += 1) out.push(data[pos]);
    } else {
      const value = data[pos];
      pos += 1;
      for (let index = 0; index < 257 - length; index += 1) out.push(value);
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// Standard security handler. Only the empty user password is tried, which
// covers files that open without a prompt but restrict printing or editing.

const passwordPadding = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
]);

function md5(...parts) {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function rc4(key, data) {
  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) state[index] = index;
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 0xff;
    const swap = state[index];
    state[index] = state[j];
    state[j] = swap;
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    const swap = state[i];
    state[i] = state[j];
    state[j] = swap;
    out[index] = data[index] ^ state[(state[i] + state[j]) & 0xff];
  }
  return out;
}

function aesDecrypt(key, data) {
  if (data.length < 32) return Buffer.alloc(0);
  const algorithm = key.length === 32 ? "aes-256-cbc" : "aes-128-cbc";
  const body = data.subarray(16, data.length - (data.length % 16));
  try {
    const decipher = createDecipheriv(algorithm, key, data.subarray(0, 16));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    const decipher = createDecipheriv(algorithm, key, data.subarray(0, 16));
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}

// ISO 32000-2 algorithm 2.B, used by revision 6 (AES-256) files.
function hashRevision6(password, salt, extra) {
  let key = createHash("sha256").update(password).update(salt).update(extra).digest();
  for (let round = 0; ; round += 1) {
    const block = Buffer.concat([password, key, extra]);
    const input = Buffer.concat(Array.from({ length: 64 }, () => block));
    const cipher = createCipheriv("aes-128-cbc", key.subarray(0, 16), key.subarray(16, 32));
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
    let sum = 0;
    for (let index = 0; index < 16; index += 1) sum += encrypted[index];
    key = createHash(["sha256", "sha384", "sha512"][sum % 3]).update(encrypted).digest();
    if (round >= 63 && encrypted[encrypted.length - 1] <= round - 31) break;
  }
  return key.subarray(0, 32);
}

function createCrypt(doc, dict) {
  const version = doc.resolve(dict.V) || 0;
  const revision = doc.resolve(dict.R) || 2;
  const ownerKey = doc.resolve(dict.O);
  const userKey = doc.resolve(dict.U);
  if (!Buffer.isBuffer(ownerKey) || !Buffer.isBuffer(userKey)) return null;
  const encryptMetadata = doc.resolve(dict.EncryptMetadata) !== false;

  const filterMethod = which => {
    const filters = doc.resolve(dict.CF);
    const name = nameOf(doc.resolve(dict[which])) || "Identity";
    if (name === "Identity" || !isDict(filters)) return "none";
    const method = nameOf(doc.resolve(doc.resolve(filters[name])?.CFM));
    return method === "AESV2" || method === "AESV3" ? "aes" : method === "V2" ? "rc4" : "none";
  };

  if (version === 5) {
    const empty = Buffer.alloc(0);
    const validationSalt = userKey.subarray(32, 40);
    const keySalt = userKey.subarray(40, 48);
    const hash = salt => revision >= 6
      ? hashRevision6(empty, salt, empty)
      : createHash("sha256").update(salt).digest();
    if (!hash(validationSalt).equals(userKey.subarray(0, 32))) return null;
    const wrapped = doc.resolve(dict.UE);
    if (!Buffer.isBuffer(wrapped) || wrapped.length < 32) return null;
    const decipher = createDecipheriv("aes-256-cbc", hash(keySalt), Buffer.alloc(16));
    decipher.setAutoPadding(false);
    const fileKey = Buffer.concat([decipher.update(wrapped.subarray(0, 32)), decipher.final()]);
    const methods = { stream: filterMethod("StmF"), string: filterMethod("StrF") };
    return {
      encryptMetadata,
      decrypt(data, _num, _gen, isStream) {
        return methods[isStream ? "stream" : "string"] === "none" ? data : aesDecrypt(fileKey, data);
      }
    };
  }

  if (version < 1 || version > 4) return null;
  const ids = doc.resolve(doc.trailer.ID);
  const id = Array.isArray(ids) && Buffer.isBuffer(doc.resolve(ids[0])) ? doc.resolve(ids[0]) : Buffer.alloc(0);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE((doc.resolve(dict.P) || 0) | 0, 0);
  const keyLength = revision === 2 ? 5 : Math.max(5, Math.min(16, (doc.resolve(dict.Length) || 40) / 8));

  let key = md5(passwordPadding, ownerKey.subarray(0, 32), permissions, id,
    revision >= 4 && !encryptMetadata ? Buffer.from([0xff, 0xff, 0xff, 0xff]) : Buffer.alloc(0));
  if (revision >= 3) {
    for (let round = 0; round < 50; round += 1) key = md5(key.subarray(0, keyLength));
  }
  key = key.subarray(0, keyLength);

  if (revision === 2) {
    if (!rc4(key, passwordPadding).equals(userKey.subarray(0, 32))) return null;
  } else {
    let check = rc4(key, md5(passwordPadding, id));
    for (let round = 1; round <= 19; round += 1) {
      check = rc4(Buffer.from(key.map(byte => byte ^ round)), check);
    }
    if (!check.equals(userKey.subarray(0, 16))) return null;
  }

  const methods = version === 4
    ? { stream: filterMethod("StmF"), string: filterMethod("StrF") }
    : { stream: "rc4", string: "rc4" };
  return {
    encryptMetadata,
    decrypt(data, num, gen, isStream) {
      const method = methods[isStream ? "stream" : "string"];
      if (method === "none") return data;
      const suffix = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
      const objectKey = md5(key, suffix, method === "aes" ? Buffer.from("sAlT") : Buffer.alloc(0))
        .subarray(0, Math.min(16, key.length + 5));
      return method === "aes" ? aesDecrypt(objectKey, data) : rc4(objectKey, data);
    }
  };
}

// ---------------------------------------------------------------------------
// Fonts

const winAnsi = (() => {
  const table = Array.from({ length: 256 }, (_, code) => String.fromCharCode(code));
  const upper = "€•‚ƒ„…†‡ˆ‰Š‹Œ•Ž•" +
    "•‘’“”•–—˜™š›œ•žŸ";
  for (let index = 0; index < 32; index += 1) table[0x80 + index] = upper[index];
  return table;
})();

const macRoman = (() => {
  const table = Array.from({ length: 256 }, (_, code) => String.fromCharCode(code));
  const upper = "ÄÅÇÉÑÖÜáàâäãåçéè" +
    "êëíìîïñóòôöõúùûü" +
    "†°¢£§•¶ß®©™´¨≠ÆØ" +
    "∞±≤≥¥µ∂∑∏π∫ªºΩæø" +
    "¿¡¬√ƒ≈∆«»… ÀÃÕŒœ" +
    "–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ" +
    "‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ" +
    "ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";
  for (let index = 0; index < 128; index += 1) table[0x80 + index] = upper[index];
  return table;
})();

const standardEncoding = (() => {
  const table = Array.from({ length: 256 }, (_, code) => (code >= 32 && code < 127 ? String.fromCharCode(code) : ""));
  table[0x27] = "’";
  table[0x60] = "‘";
  const upper = {
    0xa1: "¡", 0xa2: "¢", 0xa3: "£", 0xa4: "⁄", 0xa5: "¥", 0xa6: "ƒ", 0xa7: "§",
    0xa8: "¤", 0xa9: "'", 0xaa: "“", 0xab: "«", 0xac: "‹", 0xad: "›", 0xae: "fi", 0xaf: "fl",
    0xb1: "–", 0xb2: "†", 0xb3: "‡", 0xb4: "·", 0xb6: "¶", 0xb7: "•", 0xb8: "‚",
    0xb9: "„", 0xba: "”", 0xbb: "»", 0xbc: "…", 0xbd: "‰", 0xbf: "¿", 0xc1: "`",
    0xc2: "´", 0xc3: "ˆ", 0xc4: "˜", 0xc5: "¯", 0xc6: "˘", 0xc7: "˙", 0xc8: "¨",
    0xca: "˚", 0xcb: "¸", 0xcd: "˝", 0xce: "˛", 0xcf: "ˇ", 0xd0: "—", 0xe1: "Æ",
    0xe3: "ª", 0xe8: "Ł", 0xe9: "Ø", 0xea: "Œ", 0xeb: "º", 0xf1: "æ", 0xf5: "ı",
    0xf8: "ł", 0xf9: "ø", 0xfa: "œ", 0xfb: "ß"
  };
  for (const [code, char] of Object.entries(upper)) table[Number(code)] = char;
  return table;
})();

const glyphNames = (() => {
  const map = new Map();
  const add = (names, start) => names.split(" ").forEach((name, index) => {
    if (name !== "-") map.set(name, String.fromCharCode(start + index));
  });
  add("space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash " +
    "zero one two three four five six seven eight nine colon semicolon less equal greater question at", 0x20);
  add("bracketleft backslash bracketright asciicircum underscore grave", 0x5b);
  add("braceleft bar braceright asciitilde", 0x7b);
  add("exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot - registered macron " +
    "degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright " +
    "onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute " +
    "Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash " +
    "Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave " +
    "eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide " +
    "oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis", 0xa1);
  const extra = {
    quoteleft: "‘", quoteright: "’", quotesinglbase: "‚", quotedblleft: "“", quotedblright: "”",
    quotedblbase: "„", dagger: "†", daggerdbl: "‡", bullet: "•", ellipsis: "…", perthousand: "‰",
    guilsinglleft: "‹", guilsinglright: "›", endash: "–", emdash: "—", fraction: "⁄", florin: "ƒ",
    circumflex: "ˆ", tilde: "˜", trademark: "™", Euro: "€", OE: "Œ", oe: "œ", Scaron: "Š",
    scaron: "š", Zcaron: "Ž", zcaron: "ž", Ydieresis: "Ÿ", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl",
    dotlessi: "ı", Lslash: "Ł", lslash: "ł", caron: "ˇ", breve: "˘", dotaccent: "˙", ring: "˚",
    ogonek: "˛", hungarumlaut: "˝", nbspace: " ", nonbreakingspace: " ", sfthyphen: "­", minus: "−",
    Delta: "Δ", Omega: "Ω", pi: "π", summation: "∑", product: "∏", radical: "√", infinity: "∞",
    integral: "∫", approxequal: "≈", notequal: "≠", lessequal: "≤", greaterequal: "≥",
    partialdiff: "∂", lozenge: "◊", arrowright: "→", arrowleft: "←", checkbox: "☐", square: "□",
    circle: "○", triangle: "△", Abreve: "Ă", abreve: "ă", Aogonek: "Ą", aogonek: "ą",
    Cacute: "Ć", cacute: "ć", Ccaron: "Č", ccaron: "č", Dcaron: "Ď", dcaron: "ď",
    Eogonek: "Ę", eogonek: "ę", Ecaron: "Ě", ecaron: "ě", Gbreve: "Ğ", gbreve: "ğ",
    Idotaccent: "İ", Nacute: "Ń", nacute: "ń", Ncaron: "Ň", ncaron: "ň", Rcaron: "Ř",
    rcaron: "ř", Sacute: "Ś", sacute: "ś", Scedilla: "Ş", scedilla: "ş", Tcaron: "Ť",
    tcaron: "ť", Uring: "Ů", uring: "ů", Zacute: "Ź", zacute: "ź", Zdotaccent: "Ż",
    zdotaccent: "ż", Amacron: "Ā", amacron: "ā", Emacron: "Ē", emacron: "ē", Imacron: "Ī",
    imacron: "ī", Omacron: "Ō", omacron: "ō", Umacron: "Ū", umacron: "ū"
  };
  for (const [name, char] of Object.entries(extra)) map.set(name, char);
  return map;
})();

function glyphToUnicode(name) {
  if (glyphNames.has(name)) return glyphNames.get(name);
  if (name.length === 1) return name;
  const base = name.split(".")[0];
  if (base !== name && base) return glyphToUnicode(base);
  let match = name.match(/^uni([0-9A-Fa-f]{4})+$/);
  if (match) {
    let out = "";
    for (let index = 3; index + 4 <= name.length; index += 4) out += String.fromCharCode(Number.parseInt(name.slice(index, index + 4), 16));
    return out;
  }
  match = name.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (match) {
    const code = Number.parseInt(match[1], 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : "";
  }
  if (name.includes("_")) return name.split("_").map(glyphToUnicode).join("");
  return "";
}

function parseCMap(data) {
  const lexer = new Lexer(data, 0, true);
  const map = new Map();
  const ranges = [];
  const codeSpaces = [];
  const toCode = bytes => readUInt(bytes, 0, bytes.length);
  const toText = bytes => (bytes.length === 1 ? String.fromCharCode(bytes[0]) : utf16be(bytes));
  let mode = "";
  let operands = [];

  for (;;) {
    const token = lexer.readObject();
    if (token === EOF) break;
    if (token instanceof Op) {
      if (token.name === "begincodespacerange" || token.name === "beginbfchar" || token.name === "beginbfrange") {
        mode = token.name;
      } else if (token.name.startsWith("end")) {
        mode = "";
      }
      operands = [];
      continue;
    }
    if (!mode) continue;
    operands.push(token);

    if (mode === "begincodespacerange" && operands.length === 2) {
      const [low, high] = operands;
      if (Buffer.isBuffer(low) && Buffer.isBuffer(high)) codeSpaces.push({ length: low.length, low: toCode(low), high: toCode(high) });
      operands = [];
    } else if (mode === "beginbfchar" && operands.length === 2) {
      const [source, target] = operands;
      if (Buffer.isBuffer(source) && Buffer.isBuffer(target)) map.set(toCode(source), toText(target));
      operands = [];
    } else if (mode === "beginbfrange" && operands.length === 3) {
      const [low, high, target] = operands;
      if (Buffer.isBuffer(low) && Buffer.isBuffer(high)) {
        const start = toCode(low);
        const end = toCode(high);
        if (Array.isArray(target)) {
          target.forEach((item, index) => {
            if (Buffer.isBuffer(item)) map.set(start + index, toText(item));
          });
        } else if (Buffer.isBuffer(target) && end >= start) {
          const text = toText(target);
          const prefix = text.slice(0, -1);
          const last = text.charCodeAt(text.length - 1) || 0;
          if (end - start < 512) {
            for (let code = start; code <= end; code += 1) map.set(code, prefix + String.fromCharCode(last + code - start));
          } else {
            ranges.push({ start, end, prefix, last });
          }
        }
      }
      operands = [];
    }
  }

  return {
    codeSpaces,
    lookup(code) {
      const direct = map.get(code);
      if (direct !== undefined) return direct;
      for (const range of ranges) {
        if (code >= range.start && code <= range.end) return range.prefix + String.fromCharCode(range.last + code - range.start);
      }
      return undefined;
    }
  };
}

class PdfFont {
  constructor(doc, dict) {
    const subtype = nameOf(doc.resolve(dict.Subtype));
    const baseFont = nameOf(doc.resolve(dict.BaseFont)).replace(/^[A-Z]{6}\+/, "");
    this.name = baseFont;
    this.composite = subtype === "Type0";
    this.widthScale = 0.001;
    this.widths = new Map();
    this.defaultWidth = 0;
    this.toUnicode = null;
    this.unicodeDirect = false;
    this.codeLength = this.composite ? 2 : 1;

    const toUnicode = doc.resolve(dict.ToUnicode);
    if (toUnicode instanceof Stream) {
      try {
        this.toUnicode = parseCMap(doc.streamData(toUnicode));
      } catch {
        this.toUnicode = null;
      }
    }

    let descriptor = doc.resolve(dict.FontDescriptor);
    if (this.composite) {
      const descendants = doc.resolve(dict.DescendantFonts);
      const descendant = doc.resolve(Array.isArray(descendants) ? descendants[0] : descendants);
      const encoding = doc.resolve(dict.Encoding);
      const encodingName = nameOf(encoding);
      this.unicodeDirect = /^Uni.+-(UCS2|UTF16)-[HV]$/.test(encodingName);
      if (encoding instanceof Stream) {
        try {
          const spaces = parseCMap(doc.streamData(encoding)).codeSpaces;
          if (spaces.length) this.encodingSpaces = spaces;
        } catch {
          // Keep the two-byte default.
        }
      }
      if (isDict(descendant)) {
        descriptor = doc.resolve(descendant.FontDescriptor);
        this.defaultWidth = doc.resolve(descendant.DW) ?? 1000;
        const widths = doc.resolve(descendant.W);
        if (Array.isArray(widths)) {
          for (let index = 0; index < widths.length;) {
            const first = doc.resolve(widths[index]);
            const second = doc.resolve(widths[index + 1]);
            if (Array.isArray(second)) {
              second.forEach((width, offset) => this.widths.set(first + offset, doc.resolve(width)));
              index += 2;
            } else {
              const width = doc.resolve(widths[index + 2]);
              if (second - first < 70000) {
                for (let cid = first; cid <= second; cid += 1) this.widths.set(cid, width);
              }
              index += 3;
            }
          }
        }
      } else {
        this.defaultWidth = 1000;
      }
    } else {
      this.encoding = this.buildEncoding(doc, dict, subtype, baseFont, descriptor);
      const firstChar = doc.resolve(dict.FirstChar) || 0;
      const widths = doc.resolve(dict.Widths);
      if (Array.isArray(widths)) {
        widths.forEach((width, index) => this.widths.set(firstChar + index, doc.resolve(width) || 0));
        this.defaultWidth = isDict(descriptor) ? doc.resolve(descriptor.MissingWidth) || 0 : 0;
      } else if (/courier/i.test(baseFont)) {
        this.defaultWidth = 600;
      } else {
        // Standard 14 fonts may omit widths; Helvetica metrics are close enough for spacing.
        helveticaWidths.forEach((width, index) => this.widths.set(32 + index, width));
        this.defaultWidth = 556;
      }
      if (subtype === "Type3") {
        const matrix = doc.resolve(dict.FontMatrix);
        if (Array.isArray(matrix) && typeof matrix[0] === "number") this.widthScale = Math.abs(matrix[0]) || 0.001;
      }
    }

    const flags = isDict(descriptor) ? doc.resolve(descriptor.Flags) || 0 : 0;
    this.bold = /bold|black|heavy|semibold|demi/i.test(baseFont) || (flags & 0x40000) !== 0;
    this.italic = /italic|oblique/i.test(baseFont) || (flags & 0x40) !== 0;
  }

  buildEncoding(doc, dict, subtype, baseFont, descriptor) {
    const encoding = doc.resolve(dict.Encoding);
    const flags = isDict(descriptor) ? doc.resolve(descriptor.Flags) || 0 : 0;
    const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
    let baseName = nameOf(encoding) || (isDict(encoding) ? nameOf(doc.resolve(encoding.BaseEncoding)) : "");
    if (!baseName) baseName = subtype === "TrueType" || symbolic ? "WinAnsiEncoding" : "StandardEncoding";
    const base = baseName === "MacRomanEncoding" ? macRoman : baseName === "StandardEncoding" ? standardEncoding : winAnsi;
    const table = base.slice();
    if (/^Symbol/.test(baseFont)) table[0xb7] = "•";
    if (isDict(encoding)) {
      const differences = doc.resolve(encoding.Differences);
      if (Array.isArray(differences)) {
        let code = 0;
        for (const raw of differences) {
          const item = doc.resolve(raw);
          if (typeof item === "number") {
            code = item;
          } else if (item instanceof Name) {
            const text = glyphToUnicode(item.name);
            if (text || !this.toUnicode) table[code & 0xff] = text;
            code += 1;
          }
        }
      }
    }
    return table;
  }

  // Splits a string operand into glyphs with Unicode text and advance width.
  decode(bytes, out, doc) {
    if (!this.composite) {
      for (const code of bytes) {
        let text = this.toUnicode?.lookup(code);
        if (text === undefined || text === "\u0000") text = this.encoding[code];
        out.push({ text: text ?? "", width: (this.widths.get(code) ?? this.defaultWidth) * this.widthScale, space: code === 32 });
      }
      return;
    }

    const spaces = this.encodingSpaces || this.toUnicode?.codeSpaces;
    let pos = 0;
    while (pos < bytes.length) {
      let length = this.codeLength;
      if (spaces && spaces.length) {
        length = 0;
        for (let size = 1; size <= 4 && !length && pos + size <= bytes.length; size += 1) {
          const value = readUInt(bytes, pos, size);
          for (const space of spaces) {
            if (space.length === size && value >= space.low && value <= space.high) {
              length = size;
              break;
            }
          }
        }
        if (!length) length = Math.min(spaces[0].length, bytes.length - pos) || 1;
      }
      length = Math.min(length, bytes.length - pos);
      const code = readUInt(bytes, pos, length);
      pos += length;
      let text = this.toUnicode?.lookup(code);
      if (text === undefined && this.unicodeDirect) text = String.fromCharCode(code);
      if (text === undefined) {
        doc.unmappedGlyphs += 1;
        text = "";
      }
      out.push({ text, width: (this.widths.get(code) ?? this.defaultWidth) * 0.001, space: length === 1 && code === 32 });
    }
  }
}

// ---------------------------------------------------------------------------
// Content stream interpreter

function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ];
}

function normalizeBox(box, doc) {
  const values = Array.isArray(box) ? box.map(value => doc.resolve(value)) : null;
  if (!values || values.length < 4 || values.some(value => typeof value !== "number")) return [0, 0, 612, 792];
  const [x0, y0, x1, y1] = values;
  const result = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  return result[2] - result[0] < 1 || result[3] - result[1] < 1 ? [0, 0, 612, 792] : result;
}

function cleanGlyphText(text) {
  if (!text) return "";
  let out = text;
  if (/[\u0000-\u001fﬀ-ﬆ ]/.test(out)) {
    out = out
      .replaceAll(/[\t ]/g, " ")
      .replaceAll(/[\u0000-\u001f]/g, "")
      .replaceAll("ﬀ", "ff").replaceAll("ﬁ", "fi").replaceAll("ﬂ", "fl")
      .replaceAll("ﬃ", "ffi").replaceAll("ﬄ", "ffl").replaceAll(/[ﬅﬆ]/g, "st");
  }
  return out;
}

function extractPageRuns(doc, page) {
  const box = normalizeBox(doc.resolve(page.CropBox) || doc.resolve(page.MediaBox), doc);
  const rotate = (((doc.resolve(page.Rotate) || 0) % 360) + 360) % 360;
  const boxWidth = box[2] - box[0];
  const boxHeight = box[3] - box[1];
  const sideways = rotate === 90 || rotate === 270;
  const width = sideways ? boxHeight : boxWidth;
  const height = sideways ? boxWidth : boxHeight;
  const toDisplay = (x, y) => {
    if (rotate === 90) return [y - box[1], x - box[0]];
    if (rotate === 180) return [box[2] - x, y - box[1]];
    if (rotate === 270) return [box[3] - y, box[2] - x];
    return [x - box[0], box[3] - y];
  };

  const runs = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) runs.push(current);
    current = null;
  };

  const addGlyph = (text, x0, y0, x1, y1, size, font) => {
    const [sx, sy] = toDisplay(x0, y0);
    const [ex, ey] = toDisplay(x1, y1);
    const dx = ex - sx;
    const dy = ey - sy;
    const length = Math.hypot(dx, dy);
    let ux = 1;
    let uy = 0;
    if (length > 1e-6) {
      ux = dx / length;
      uy = dy / length;
    } else if (current) {
      ux = current.ux;
      uy = current.uy;
    }

    if (current) {
      const gapX = sx - current.ex;
      const gapY = sy - current.ey;
      const along = gapX * current.ux + gapY * current.uy;
      const across = Math.abs(-gapX * current.uy + gapY * current.ux);
      const sameStyle = Math.abs(current.size - size) <= 0.03 * size && current.bold === font.bold &&
        Math.abs(current.ux - ux) < 0.02 && Math.abs(current.uy - uy) < 0.02;
      if (sameStyle && across < 0.2 * size && along > -0.6 * size && along < 0.55 * size) {
        if (along > 0.17 * size && text !== " " && !current.text.endsWith(" ")) current.text += " ";
        if (!(text === " " && current.text.endsWith(" "))) current.text += text;
        current.ex = ex;
        current.ey = ey;
        return;
      }
      flush();
    }
    if (!text.trim()) return;
    current = { text, sx, sy, ex, ey, ux, uy, size, bold: font.bold, italic: font.italic };
  };

  const glyphs = [];
  const run = (data, resources, initialMatrix, depth) => {
    const lexer = new Lexer(data, 0, true);
    const fontDict = doc.resolve(isDict(resources) ? resources.Font : null);
    const xobjects = doc.resolve(isDict(resources) ? resources.XObject : null);
    const stack = [];
    let ctm = initialMatrix;
    let tm = [1, 0, 0, 1, 0, 0];
    let lineMatrix = tm;
    let font = null;
    let fontSize = 0;
    let charSpacing = 0;
    let wordSpacing = 0;
    let scale = 1;
    let leading = 0;
    let rise = 0;
    let operands = [];

    const show = bytes => {
      if (!font || !Buffer.isBuffer(bytes)) return;
      glyphs.length = 0;
      font.decode(bytes, glyphs, doc);
      for (const glyph of glyphs) {
        const matrix = multiply(tm, ctm);
        const x0 = matrix[4] + rise * matrix[2];
        const y0 = matrix[5] + rise * matrix[3];
        const glyphWidth = glyph.width * fontSize * scale;
        const size = Math.abs(fontSize) * Math.hypot(matrix[2], matrix[3]);
        const text = cleanGlyphText(glyph.text);
        if (size > 0.5 && (text || current)) {
          // Letter-spacing is part of the glyph's advance, so tracked text is not split into letters.
          const spaced = glyphWidth + Math.max(0, charSpacing) * scale;
          addGlyph(text, x0, y0, x0 + spaced * matrix[0], y0 + spaced * matrix[1], size, font);
        }
        const advance = glyphWidth + (charSpacing + (glyph.space ? wordSpacing : 0)) * scale;
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
      }
    };
    const nextLine = (tx, ty) => {
      lineMatrix = multiply([1, 0, 0, 1, tx, ty], lineMatrix);
      tm = lineMatrix;
    };
    const num = index => (typeof operands[index] === "number" ? operands[index] : 0);

    for (;;) {
      const token = lexer.readObject();
      if (token === EOF) break;
      if (!(token instanceof Op)) {
        if (token !== CLOSE_ARRAY && token !== CLOSE_DICT) operands.push(token);
        if (operands.length > 64) operands.shift();
        continue;
      }

      switch (token.name) {
        case "BT":
          tm = [1, 0, 0, 1, 0, 0];
          lineMatrix = tm;
          break;
        case "Tf": {
          const fontName = nameOf(operands[0]);
          font = isDict(fontDict) && fontDict[fontName] !== undefined ? doc.getFont(fontDict[fontName]) : null;
          fontSize = num(1);
          break;
        }
        case "Td":
          nextLine(num(0), num(1));
          break;
        case "TD":
          leading = -num(1);
          nextLine(num(0), num(1));
          break;
        case "Tm":
          tm = [num(0), num(1), num(2), num(3), num(4), num(5)];
          lineMatrix = tm;
          break;
        case "T*":
          nextLine(0, -leading);
          break;
        case "Tj":
          show(operands[0]);
          break;
        case "'":
          nextLine(0, -leading);
          show(operands[0]);
          break;
        case "\"":
          wordSpacing = num(0);
          charSpacing = num(1);
          nextLine(0, -leading);
          show(operands[2]);
          break;
        case "TJ":
          if (Array.isArray(operands[0])) {
            for (const item of operands[0]) {
              if (typeof item === "number") tm = multiply([1, 0, 0, 1, -item / 1000 * fontSize * scale, 0], tm);
              else show(item);
            }
          }
          break;
        case "Tc":
          charSpacing = num(0);
          break;
        case "Tw":
          wordSpacing = num(0);
          break;
        case "Tz":
          scale = num(0) / 100 || 1;
          break;
        case "TL":
          leading = num(0);
          break;
        case "Ts":
          rise = num(0);
          break;
        case "cm":
          ctm = multiply([num(0), num(1), num(2), num(3), num(4), num(5)], ctm);
          break;
        case "q":
          stack.push([ctm, font, fontSize, charSpacing, wordSpacing, scale, leading, rise]);
          break;
        case "Q":
          if (stack.length) [ctm, font, fontSize, charSpacing, wordSpacing, scale, leading, rise] = stack.pop();
          break;
        case "Do": {
          const target = isDict(xobjects) ? doc.resolve(xobjects[nameOf(operands[0])]) : null;
          if (target instanceof Stream && nameOf(doc.resolve(target.dict.Subtype)) === "Form" && depth < 12) {
            const matrix = doc.resolve(target.dict.Matrix);
            const formMatrix = Array.isArray(matrix) && matrix.length === 6 ? matrix.map(value => doc.resolve(value) || 0) : [1, 0, 0, 1, 0, 0];
            const formResources = doc.resolve(target.dict.Resources) || resources;
            run(doc.streamData(target), formResources, multiply(formMatrix, ctm), depth + 1);
          }
          break;
        }
        case "BI": {
          // Inline image: skip the dictionary and the binary data up to EI.
          for (;;) {
            const item = lexer.readObject();
            if (item === EOF || (item instanceof Op && item.name === "ID")) break;
          }
          let end = lexer.pos;
          for (;;) {
            end = data.indexOf("EI", end + 1);
            if (end < 0) {
              end = data.length;
              break;
            }
            if (whitespace[data[end - 1]] && (end + 2 >= data.length || whitespace[data[end + 2]] || data[end + 2] === 0x51)) break;
          }
          lexer.pos = Math.min(data.length, end + 2);
          break;
        }
        default:
          break;
      }
      operands = [];
    }
  };

  const contents = doc.resolve(page.dict.Contents);
  const parts = (Array.isArray(contents) ? contents : [contents])
    .map(item => doc.resolve(item))
    .filter(item => item instanceof Stream)
    .map(item => doc.streamData(item));
  if (parts.length) {
    const joined = Buffer.concat(parts.flatMap(part => [part, Buffer.from("\n")]));
    run(joined, doc.resolve(page.Resources), [1, 0, 0, 1, 0, 0], 0);
  }
  flush();
  return { width, height, runs };
}

export function readPdf(buffer) {
  const doc = new PdfDocument(buffer);
  const pages = [];
  for (const page of doc.getPages()) {
    try {
      pages.push(extractPageRuns(doc, page));
    } catch {
      pages.push({ width: 612, height: 792, runs: [] });
    }
  }
  return { title: doc.getTitle(), pages, unmappedGlyphs: doc.unmappedGlyphs };
}
