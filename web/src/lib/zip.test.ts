import { describe, expect, it } from "vitest";

import { createZip } from "@/lib/zip";

const decoder = new TextDecoder();

function uint16(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readStoredEntries(bytes: Uint8Array) {
  const entries: Array<{ name: string; data: Uint8Array; crc: number; offset: number }> = [];
  let offset = 0;

  while (uint32(bytes, offset) === 0x04034b50) {
    const flags = uint16(bytes, offset + 6);
    const compression = uint16(bytes, offset + 8);
    const crc = uint32(bytes, offset + 14);
    const compressedSize = uint32(bytes, offset + 18);
    const uncompressedSize = uint32(bytes, offset + 22);
    const nameLength = uint16(bytes, offset + 26);
    const extraLength = uint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;

    expect(flags & 0x0800).toBe(0x0800);
    expect(compression).toBe(0);
    expect(compressedSize).toBe(uncompressedSize);

    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      data: bytes.slice(dataStart, dataStart + compressedSize),
      crc,
      offset,
    });
    offset = dataStart + compressedSize;
  }

  return { entries, centralOffset: offset };
}

function readCentralDirectory(bytes: Uint8Array, centralOffset: number, count: number) {
  const entries: Array<{ name: string; localOffset: number }> = [];
  let offset = centralOffset;

  for (let index = 0; index < count; index++) {
    expect(uint32(bytes, offset)).toBe(0x02014b50);
    const nameLength = uint16(bytes, offset + 28);
    const extraLength = uint16(bytes, offset + 30);
    const commentLength = uint16(bytes, offset + 32);
    const nameStart = offset + 46;
    entries.push({
      name: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      localOffset: uint32(bytes, offset + 42),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return { entries, endOffset: offset };
}

describe("createZip", () => {
  it("emits a standards-shaped stored entry with the known CRC-32 vector", () => {
    const zip = createZip({ "hello.txt": "hello" }, new Date(2026, 7, 7, 12, 34, 56));
    const { entries, centralOffset } = readStoredEntries(zip);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "hello.txt",
      crc: 0x3610a686,
      offset: 0,
    });
    expect(decoder.decode(entries[0].data)).toBe("hello");

    const central = readCentralDirectory(zip, centralOffset, 1);
    expect(central.entries).toEqual([{ name: "hello.txt", localOffset: 0 }]);
    expect(uint32(zip, central.endOffset)).toBe(0x06054b50);
    expect(uint16(zip, central.endOffset + 10)).toBe(1);
    expect(uint32(zip, central.endOffset + 16)).toBe(centralOffset);
    expect(central.endOffset + 22).toBe(zip.byteLength);
  });

  it("preserves UTF-8 paths, binary bytes, and central-directory offsets for multiple files", () => {
    const binary = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const zip = createZip(
      {
        "简历/说明.txt": "你好, Typst!",
        "assets/font.bin": binary,
      },
      new Date(2026, 0, 2, 3, 4, 6),
    );
    const { entries, centralOffset } = readStoredEntries(zip);

    expect(entries.map((entry) => entry.name)).toEqual(["简历/说明.txt", "assets/font.bin"]);
    expect(decoder.decode(entries[0].data)).toBe("你好, Typst!");
    expect(entries[1].data).toEqual(binary);

    const central = readCentralDirectory(zip, centralOffset, entries.length);
    expect(central.entries).toEqual(entries.map((entry) => ({ name: entry.name, localOffset: entry.offset })));
    expect(uint16(zip, central.endOffset + 8)).toBe(2);
    expect(uint16(zip, central.endOffset + 10)).toBe(2);
    expect(uint32(zip, central.endOffset + 12)).toBe(central.endOffset - centralOffset);
  });

  it("creates a valid empty archive", () => {
    const zip = createZip({}, new Date(2026, 0, 1));

    expect(zip.byteLength).toBe(22);
    expect(uint32(zip, 0)).toBe(0x06054b50);
    expect(uint16(zip, 8)).toBe(0);
    expect(uint16(zip, 10)).toBe(0);
    expect(uint32(zip, 12)).toBe(0);
    expect(uint32(zip, 16)).toBe(0);
  });
});
