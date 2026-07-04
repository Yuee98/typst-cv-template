import type { CvData } from "@/lib/cv/schema";
import { buildTypstDocument } from "@/lib/cv/typst";
import { loadLocalFontData } from "@/lib/typst/font-access";
import { addFontFromData, fetchStyleSource, renderTypstPdf } from "@/lib/typst/render";
import { createZip } from "@/lib/zip";

export type CvExportFormat = "pdf" | "typst-package" | "typst-source" | "json";

const CUSTOM_FONT_SENTINEL = "__custom__";

function selectedFontFamilies(data: CvData) {
  if (!data.bodyFont || data.bodyFont === CUSTOM_FONT_SENTINEL) return [];

  return data.bodyFont
    .split(",")
    .map((font) => font.trim())
    .filter(Boolean);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toArrayBuffer(data: Uint8Array) {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

function safeDownloadName(title: string, extension: string) {
  const baseName = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${baseName || "resume"}.${extension}`;
}

function buildTypstPackageReadme() {
  return [
    "Typst CV package",
    "",
    "Files:",
    "- resume.typ: generated Typst source",
    "- style.typ: template style used by the web preview",
    "- data.json: structured CV data backup",
    "",
    "Compile locally:",
    "typst compile resume.typ resume.pdf",
    "",
    "If this CV uses custom local fonts, install fonts with matching family names before compiling locally.",
    "",
  ].join("\n");
}

export async function ensureLocalFontsForData(data: CvData) {
  const families = selectedFontFamilies(data);
  if (families.length === 0) return;

  const fontData = await loadLocalFontData(families);
  for (const data of fontData) {
    addFontFromData(data);
  }
}

export function downloadCvJson(data: CvData, title: string) {
  const payload = JSON.stringify(data, null, 2);
  downloadBlob(new Blob([payload], { type: "application/json" }), safeDownloadName(title || "cv-data", "json"));
}

export async function downloadCvPdf(data: CvData, title: string) {
  await ensureLocalFontsForData(data);
  const document = buildTypstDocument(data);
  const pdf = await renderTypstPdf(document);
  downloadBlob(new Blob([toArrayBuffer(pdf)], { type: "application/pdf" }), safeDownloadName(title, "pdf"));
}

export function downloadTypstSource(data: CvData, title: string) {
  const source = buildTypstDocument(data, { styleImportPath: "style.typ" });
  downloadBlob(new Blob([source], { type: "text/plain;charset=utf-8" }), safeDownloadName(title, "typ"));
}

export async function downloadTypstPackage(data: CvData, title: string) {
  const styleSource = await fetchStyleSource();
  const source = buildTypstDocument(data, { styleImportPath: "style.typ" });
  const zip = createZip({
    "resume.typ": source,
    "style.typ": styleSource,
    "data.json": JSON.stringify(data, null, 2),
    "README.txt": buildTypstPackageReadme(),
  });

  downloadBlob(
    new Blob([toArrayBuffer(zip)], { type: "application/zip" }),
    safeDownloadName(`${title} typst package`, "zip"),
  );
}
