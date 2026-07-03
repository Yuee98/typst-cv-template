import type { CvData } from "./schema";
import { sampleCvData } from "./sample-data";
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

export function titleFromImportedData(data: CvData) {
  const name = data.header.name.trim();
  return name ? `${name} CV` : "Imported CV";
}

export function createEmptyCvData(): CvData {
  return {
    schemaVersion: 5,
    typstLang: sampleCvData.typstLang,
    bodyFont: sampleCvData.bodyFont,
    header: {
      name: "",
      subtitle: "",
      email: "",
      phone: "",
      selfName: "",
    },
    sectionTitles: cloneCvData(sampleCvData).sectionTitles,
    profile: [],
    skills: [],
    experience: [],
    education: [],
    research: [],
    publications: [],
    additional: [],
  };
}
