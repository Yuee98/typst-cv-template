type ZipInput = string | Uint8Array;

const encoder = new TextEncoder();

const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encode(input: ZipInput) {
  return typeof input === "string" ? encoder.encode(input) : input;
}

function dosTime(date: Date) {
  return (
    (date.getHours() << 11)
    | (date.getMinutes() << 5)
    | Math.floor(date.getSeconds() / 2)
  );
}

function dosDate(date: Date) {
  return (
    ((date.getFullYear() - 1980) << 9)
    | ((date.getMonth() + 1) << 5)
    | date.getDate()
  );
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function makeLocalHeader(fileName: Uint8Array, data: Uint8Array, crc: number, modifiedAt: Date) {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, 0x04034b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 0x0800);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, dosTime(modifiedAt));
  writeUint16(view, 12, dosDate(modifiedAt));
  writeUint32(view, 14, crc);
  writeUint32(view, 18, data.byteLength);
  writeUint32(view, 22, data.byteLength);
  writeUint16(view, 26, fileName.byteLength);
  writeUint16(view, 28, 0);
  return header;
}

function makeCentralHeader(
  fileName: Uint8Array,
  data: Uint8Array,
  crc: number,
  modifiedAt: Date,
  localHeaderOffset: number,
) {
  const header = new Uint8Array(46);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, 0x02014b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 20);
  writeUint16(view, 8, 0x0800);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, dosTime(modifiedAt));
  writeUint16(view, 14, dosDate(modifiedAt));
  writeUint32(view, 16, crc);
  writeUint32(view, 20, data.byteLength);
  writeUint32(view, 24, data.byteLength);
  writeUint16(view, 28, fileName.byteLength);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, localHeaderOffset);
  return header;
}

function makeEndRecord(fileCount: number, centralSize: number, centralOffset: number) {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  writeUint32(view, 0, 0x06054b50);
  writeUint16(view, 4, 0);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, fileCount);
  writeUint16(view, 10, fileCount);
  writeUint32(view, 12, centralSize);
  writeUint32(view, 16, centralOffset);
  writeUint16(view, 20, 0);
  return record;
}

function concat(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function createZip(files: Record<string, ZipInput>, modifiedAt = new Date()) {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const [path, input] of Object.entries(files)) {
    const fileName = encoder.encode(path);
    const data = encode(input);
    const crc = crc32(data);
    const localOffset = offset;
    const localHeader = makeLocalHeader(fileName, data, crc, modifiedAt);

    localChunks.push(localHeader, fileName, data);
    offset += localHeader.byteLength + fileName.byteLength + data.byteLength;

    const centralHeader = makeCentralHeader(fileName, data, crc, modifiedAt, localOffset);
    centralChunks.push(centralHeader, fileName);
  }

  const centralOffset = offset;
  const central = concat(centralChunks);
  const endRecord = makeEndRecord(Object.keys(files).length, central.byteLength, centralOffset);
  return concat([...localChunks, central, endRecord]);
}
