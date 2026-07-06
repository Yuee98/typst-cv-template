import { CV_SCHEMA_VERSION, DEFAULT_SECTION_ORDER, type CvData } from "./schema";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { getSampleCvData } from "./sample-data";
import type { CvDocumentSummary, LocalCvDocument } from "./storage";

export function cloneCvData(data: CvData): CvData {
  return JSON.parse(JSON.stringify(data)) as CvData;
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function summarizeLocalDocument(document: LocalCvDocument): CvDocumentSummary {
  return {
    id: document.id,
    title: document.title,
    storageKind: document.storageKind,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export function titleFromImportedData(data: CvData, fallback = "Imported CV") {
  const name = data.header.name.trim();
  return name ? `${name} CV` : fallback;
}

export function createEmptyCvData(locale: Locale = defaultLocale): CvData {
  const sample = getSampleCvData(locale);

  return {
    schemaVersion: CV_SCHEMA_VERSION,
    typstLang: sample.typstLang,
    bodyFont: sample.bodyFont,
    sectionOrder: [...DEFAULT_SECTION_ORDER],
    header: {
      name: "",
      subtitle: "",
      email: "",
      phone: "",
      selfName: "",
    },
    sectionTitles: cloneCvData(sample).sectionTitles,
    profile: [],
    skills: [],
    experience: [],
    education: [],
    research: [],
    publications: [],
    additional: [],
  };
}
