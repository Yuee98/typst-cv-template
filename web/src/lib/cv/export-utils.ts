import { defaultLocale, type Locale } from "@/i18n/routing";
import type { CvData } from "@/lib/cv/schema";
import { buildTypstDocument } from "@/lib/cv/typst";
import { loadLocalFontData } from "@/lib/typst/font-access";
import { addFontFromData, fetchStyleSource, renderTypstPdf } from "@/lib/typst/render";
import { createZip } from "@/lib/zip";

export type CvExportFormat = "pdf" | "typst-package" | "typst-source" | "json";

const CUSTOM_FONT_SENTINEL = "__custom__";

const exportMessages = {
  en: {
    fallbackFileName: "resume",
    fallbackJsonName: "cv-data",
    typstPackageSuffix: (title: string) => `${title} typst package`,
    readme: {
      title: "Typst CV package",
      files: "Files:",
      resumeTyp: "generated Typst source",
      styleTyp: "template style used by the web preview",
      dataJson: "structured CV data backup",
      compile: "Compile locally:",
      command: "typst compile resume.typ resume.pdf",
      fonts: "If this CV uses custom local fonts, install fonts with matching family names before compiling locally.",
    },
  },
  zh: {
    fallbackFileName: "简历",
    fallbackJsonName: "cv-data",
    typstPackageSuffix: (title: string) => `${title} typst 包`,
    readme: {
      title: "Typst CV 包",
      files: "文件：",
      resumeTyp: "生成的 Typst 源文件",
      styleTyp: "网页预览使用的模板样式",
      dataJson: "结构化 CV 数据备份",
      compile: "本地编译：",
      command: "typst compile resume.typ resume.pdf",
      fonts: "如果此 CV 使用了自定义本地字体，请在本地编译前安装相同字族名称的字体。",
    },
  },
};

function getExportMessages(locale: Locale) {
  return exportMessages[locale] ?? exportMessages.en;
}

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

function safeDownloadName(title: string, extension: string, locale: Locale = defaultLocale) {
  const baseName = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${baseName || getExportMessages(locale).fallbackFileName}.${extension}`;
}

function buildTypstPackageReadme(locale: Locale = defaultLocale) {
  const m = getExportMessages(locale).readme;
  return [
    m.title,
    "",
    m.files,
    `- resume.typ: ${m.resumeTyp}`,
    `- style.typ: ${m.styleTyp}`,
    `- data.json: ${m.dataJson}`,
    "",
    m.compile,
    m.command,
    "",
    m.fonts,
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

export function downloadCvJson(data: CvData, title: string, locale: Locale = defaultLocale) {
  const payload = JSON.stringify(data, null, 2);
  downloadBlob(
    new Blob([payload], { type: "application/json" }),
    safeDownloadName(title || getExportMessages(locale).fallbackJsonName, "json", locale),
  );
}

export async function downloadCvPdf(data: CvData, title: string, locale: Locale = defaultLocale) {
  await ensureLocalFontsForData(data);
  const document = buildTypstDocument(data);
  const pdf = await renderTypstPdf(document, undefined, locale);
  downloadBlob(new Blob([toArrayBuffer(pdf)], { type: "application/pdf" }), safeDownloadName(title, "pdf", locale));
}

export function downloadTypstSource(data: CvData, title: string, locale: Locale = defaultLocale) {
  const source = buildTypstDocument(data, { styleImportPath: "style.typ" });
  downloadBlob(new Blob([source], { type: "text/plain;charset=utf-8" }), safeDownloadName(title, "typ", locale));
}

export async function downloadTypstPackage(data: CvData, title: string, locale: Locale = defaultLocale) {
  const styleSource = await fetchStyleSource(locale);
  const source = buildTypstDocument(data, { styleImportPath: "style.typ" });
  const m = getExportMessages(locale);
  const zip = createZip({
    "resume.typ": source,
    "style.typ": styleSource,
    "data.json": JSON.stringify(data, null, 2),
    "README.txt": buildTypstPackageReadme(locale),
  });

  downloadBlob(
    new Blob([toArrayBuffer(zip)], { type: "application/zip" }),
    safeDownloadName(m.typstPackageSuffix(title), "zip", locale),
  );
}
