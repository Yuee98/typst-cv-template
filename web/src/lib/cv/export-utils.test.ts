// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadCvJson,
  downloadCvPdf,
  downloadTypstPackage,
  downloadTypstSource,
  ensureLocalFontsForData,
} from "@/lib/cv/export-utils";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
import { loadLocalFontData } from "@/lib/typst/font-access";
import { addFontFromData, fetchStyleSource, renderTypstPdf } from "@/lib/typst/render";

vi.mock("@/lib/typst/font-access", () => ({
  loadLocalFontData: vi.fn(),
}));

vi.mock("@/lib/typst/render", () => ({
  addFontFromData: vi.fn(),
  fetchStyleSource: vi.fn(),
  renderTypstPdf: vi.fn(),
}));

const decoder = new TextDecoder();
let blobs: Blob[];
let downloads: Array<{ href: string; name: string }>;

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(new Uint8Array(reader.result as ArrayBuffer)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsArrayBuffer(blob);
  });
}

function uint16(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readZipFiles(bytes: Uint8Array) {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (uint32(bytes, offset) === 0x04034b50) {
    const size = uint32(bytes, offset + 18);
    const nameLength = uint16(bytes, offset + 26);
    const extraLength = uint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    files.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return files;
}

beforeEach(() => {
  vi.clearAllMocks();
  blobs = [];
  downloads = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:test-${blobs.length}`;
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, name: this.download });
  });
  vi.mocked(loadLocalFontData).mockResolvedValue([]);
  vi.mocked(fetchStyleSource).mockResolvedValue("#let template = true");
  vi.mocked(renderTypstPdf).mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CV download payloads", () => {
  it("downloads schema-valid JSON with a sanitized file name and revokes the URL", async () => {
    const data = cloneCvData(sampleCvDataEn);

    downloadCvJson(data, '  My / CV:*? "2026"  ', "en");

    expect(downloads).toEqual([{ href: "blob:test-1", name: "My---CV---2026.json" }]);
    expect(blobs[0].type).toBe("application/json");
    expect(JSON.parse(decoder.decode(await readBlob(blobs[0])))).toEqual(data);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
  });

  it("uses localized fallback names for blank titles", () => {
    downloadTypstSource(cloneCvData(sampleCvDataEn), "   ", "zh");

    expect(downloads[0].name).toBe("简历.typ");
    expect(blobs[0].type).toBe("text/plain;charset=utf-8");
  });

  it("builds a self-contained UTF-8 Typst package", async () => {
    const data = cloneCvData(sampleCvDataEn);
    data.header.name = "Package Candidate";

    await downloadTypstPackage(data, "Candidate", "en");

    expect(fetchStyleSource).toHaveBeenCalledWith("en");
    expect(downloads[0].name).toBe("Candidate-typst-package.zip");
    expect(blobs[0].type).toBe("application/zip");

    const files = readZipFiles(await readBlob(blobs[0]));
    expect([...files.keys()]).toEqual(["resume.typ", "style.typ", "data.json", "README.txt"]);
    expect(decoder.decode(files.get("style.typ"))).toBe("#let template = true");
    expect(decoder.decode(files.get("resume.typ"))).toContain('#import "style.typ"');
    expect(JSON.parse(decoder.decode(files.get("data.json")))).toEqual(data);
    expect(decoder.decode(files.get("README.txt"))).toContain("Typst CV package");
    expect(decoder.decode(files.get("README.txt"))).toContain("typst compile resume.typ resume.pdf");
  });
});

describe("PDF and local-font export", () => {
  it("loads each selected font before rendering and downloads PDF bytes", async () => {
    const data = cloneCvData(sampleCvDataEn);
    data.header.name = "PDF Candidate";
    data.bodyFont = "First Family, Second Family";
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6]);
    vi.mocked(loadLocalFontData).mockResolvedValue([first, second]);

    await downloadCvPdf(data, "Candidate", "zh");

    expect(loadLocalFontData).toHaveBeenCalledWith(["First Family", "Second Family"]);
    expect(addFontFromData).toHaveBeenNthCalledWith(1, first);
    expect(addFontFromData).toHaveBeenNthCalledWith(2, second);
    expect(renderTypstPdf).toHaveBeenCalledWith(expect.stringContaining("PDF Candidate"), undefined, "zh");
    expect(downloads[0].name).toBe("Candidate.pdf");
    expect(blobs[0].type).toBe("application/pdf");
    expect(await readBlob(blobs[0])).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
  });

  it("does not query local fonts for automatic or custom-family modes", async () => {
    const automatic = cloneCvData(sampleCvDataEn);
    automatic.bodyFont = "";
    const custom = cloneCvData(sampleCvDataEn);
    custom.bodyFont = "__custom__";

    await ensureLocalFontsForData(automatic);
    await ensureLocalFontsForData(custom);

    expect(loadLocalFontData).not.toHaveBeenCalled();
    expect(addFontFromData).not.toHaveBeenCalled();
  });
});
