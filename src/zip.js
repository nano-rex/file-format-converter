import { deflateRawSync, inflateRawSync } from "node:zlib";

export function createZip(files) {
  const fileRecords = [];
  const centralRecords = [];
  let offset = 0;

  for (const [name, body] of files) {
    const nameBuffer = Buffer.from(name);
    const input = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const compressed = deflateRawSync(input);
    const crc = crc32(input);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(input.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    fileRecords.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(input.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralStart = offset;
  const centralSize = centralRecords.reduce((total, record) => total + record.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...fileRecords, ...centralRecords, end]);
}

// Returns a Map of entry name to a lazy reader, so large unused parts
// (images, embedded media) are never inflated.
export function readZip(buffer) {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) throw new Error("This file is not a valid ZIP-based Office document.");
  let entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);

  // ZIP64 archives store the real values in a separate record.
  const locator = eocdOffset - 20;
  if (locator >= 0 && buffer.readUInt32LE(locator) === 0x07064b50) {
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    if (buffer.readUInt32LE(record) === 0x06064b50) {
      entryCount = Number(buffer.readBigUInt64LE(record + 32));
      cursor = Number(buffer.readBigUInt64LE(record + 48));
    }
  }

  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    let compressedSize = buffer.readUInt32LE(cursor + 20);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8").replaceAll("\\", "/");

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const fileSize = buffer.readUInt32LE(cursor + 24);
      let extra = cursor + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = buffer.readUInt16LE(extra);
        const size = buffer.readUInt16LE(extra + 2);
        if (id === 1) {
          let field = extra + 4;
          if (fileSize === 0xffffffff) field += 8;
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buffer.readBigUInt64LE(field));
            field += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(buffer.readBigUInt64LE(field));
        }
        extra += 4 + size;
      }
    }

    const size = compressedSize;
    const start = localOffset;
    entries.set(name, {
      encrypted: (flags & 1) === 1,
      read() {
        if (method !== 0 && method !== 8) throw new Error(`ZIP entry ${name} uses an unsupported compression method.`);
        const localNameLength = buffer.readUInt16LE(start + 26);
        const localExtraLength = buffer.readUInt16LE(start + 28);
        const dataStart = start + 30 + localNameLength + localExtraLength;
        const data = buffer.subarray(dataStart, dataStart + size);
        return method === 0 ? data : inflateRawSync(data);
      }
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (!entries.size) throw new Error("This file is not a valid ZIP-based Office document.");
  return entries;
}

export function zipText(entries, name) {
  const entry = entries.get(name) || entries.get(name.replace(/^\//, ""));
  return entry ? entry.read().toString("utf8") : "";
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});
