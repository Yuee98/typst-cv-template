import { z } from "zod";

import { cvSchema, type CvData } from "./schema";

const LEGACY_CV_STORAGE_KEY = "typst-cv-builder:data";
const DOCUMENT_INDEX_KEY = "typst-cv-builder:documents:index";
const ACTIVE_DOCUMENT_KEY = "typst-cv-builder:documents:active";
const LIBRARY_COLLAPSED_KEY = "typst-cv-builder:ui:library-collapsed";
const DOCUMENT_KEY_PREFIX = "typst-cv-builder:documents:";

const documentStorageKindSchema = z.enum(["local", "cloud", "encrypted"]);

const documentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  storageKind: documentStorageKindSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const documentIndexSchema = z.object({
  version: z.literal(1),
  documents: z.array(documentSummarySchema),
});

const localDocumentSchema = documentSummarySchema.extend({
  storageKind: z.literal("local"),
  data: cvSchema,
});

export type CvStorageKind = z.infer<typeof documentStorageKindSchema>;
export type CvDocumentSummary = z.infer<typeof documentSummarySchema>;
export type LocalCvDocument = z.infer<typeof localDocumentSchema>;

export type CvDocumentLibrary = {
  documents: CvDocumentSummary[];
  activeDocumentId: string | null;
};

function canUseBrowserStorage() {
  return typeof window !== "undefined";
}

function documentKey(id: string) {
  return `${DOCUMENT_KEY_PREFIX}${id}`;
}

function createDocumentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(raw: string | null, schema: z.ZodType<T>) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readDocumentIndex() {
  if (!canUseBrowserStorage()) {
    return { version: 1, documents: [] } satisfies z.infer<typeof documentIndexSchema>;
  }

  return (
    parseJson(window.localStorage.getItem(DOCUMENT_INDEX_KEY), documentIndexSchema) ?? {
      version: 1,
      documents: [],
    }
  );
}

function readExistingDocumentIndex() {
  if (!canUseBrowserStorage()) {
    return null;
  }

  return parseJson(window.localStorage.getItem(DOCUMENT_INDEX_KEY), documentIndexSchema);
}

function writeDocumentIndex(documents: CvDocumentSummary[]) {
  window.localStorage.setItem(
    DOCUMENT_INDEX_KEY,
    JSON.stringify({ version: 1, documents } satisfies z.infer<typeof documentIndexSchema>),
  );
}

function readLegacyCvData() {
  if (!canUseBrowserStorage()) {
    return null;
  }

  return parseJson(window.localStorage.getItem(LEGACY_CV_STORAGE_KEY), cvSchema);
}

function writeLocalDocument(document: LocalCvDocument) {
  window.localStorage.setItem(documentKey(document.id), JSON.stringify(document));
}

function summaryFromDocument(document: LocalCvDocument): CvDocumentSummary {
  return {
    id: document.id,
    title: document.title,
    storageKind: document.storageKind,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function titleFromData(data: CvData, fallback: string) {
  const name = data.header.name.trim();
  return name.length > 0 ? name : fallback;
}

function createLocalDocumentRecord(data: CvData, title?: string): LocalCvDocument {
  const timestamp = nowIso();

  return {
    id: createDocumentId(),
    title: title?.trim() || titleFromData(data, "Untitled CV"),
    storageKind: "local",
    data,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function loadCvDocument(id: string): LocalCvDocument | null {
  if (!canUseBrowserStorage()) {
    return null;
  }

  return parseJson(window.localStorage.getItem(documentKey(id)), localDocumentSchema);
}

export function saveActiveCvDocumentId(id: string | null) {
  if (!canUseBrowserStorage()) {
    return;
  }

  if (id) {
    window.localStorage.setItem(ACTIVE_DOCUMENT_KEY, id);
  } else {
    window.localStorage.removeItem(ACTIVE_DOCUMENT_KEY);
  }
}

export function initializeCvDocumentLibrary(defaultData: CvData): CvDocumentLibrary {
  if (!canUseBrowserStorage()) {
    return { documents: [], activeDocumentId: null };
  }

  const index = readExistingDocumentIndex();

  if (!index) {
    const initialData = readLegacyCvData() ?? defaultData;
    const initialDocument = createLocalDocumentRecord(initialData, titleFromData(initialData, "Local CV"));
    writeLocalDocument(initialDocument);
    const documents = [summaryFromDocument(initialDocument)];
    writeDocumentIndex(documents);
    saveActiveCvDocumentId(initialDocument.id);

    return { documents, activeDocumentId: initialDocument.id };
  }

  const documents = index.documents;
  const storedActiveId = window.localStorage.getItem(ACTIVE_DOCUMENT_KEY);
  const activeDocumentId = documents.some((document) => document.id === storedActiveId)
    ? storedActiveId
    : documents[0]?.id ?? null;

  saveActiveCvDocumentId(activeDocumentId);
  return { documents, activeDocumentId };
}

export function createLocalCvDocument(data: CvData, title?: string): LocalCvDocument {
  const document = createLocalDocumentRecord(data, title);
  const index = readDocumentIndex();
  const documents = [summaryFromDocument(document), ...index.documents];
  writeLocalDocument(document);
  writeDocumentIndex(documents);
  saveActiveCvDocumentId(document.id);

  return document;
}

export function updateLocalCvDocumentData(id: string, data: CvData): LocalCvDocument | null {
  const current = loadCvDocument(id);
  if (!current) {
    return null;
  }

  const nextDocument: LocalCvDocument = {
    ...current,
    data,
    updatedAt: nowIso(),
  };
  const index = readDocumentIndex();
  const documents = index.documents.map((document) =>
    document.id === id ? summaryFromDocument(nextDocument) : document,
  );

  writeLocalDocument(nextDocument);
  writeDocumentIndex(documents);
  return nextDocument;
}

export function renameCvDocument(id: string, title: string): CvDocumentSummary[] {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return readDocumentIndex().documents;
  }

  const current = loadCvDocument(id);
  const timestamp = nowIso();
  const index = readDocumentIndex();
  const documents = index.documents.map((document) =>
    document.id === id ? { ...document, title: trimmedTitle, updatedAt: timestamp } : document,
  );

  if (current) {
    writeLocalDocument({ ...current, title: trimmedTitle, updatedAt: timestamp });
  }

  writeDocumentIndex(documents);
  return documents;
}

export function duplicateCvDocument(id: string): LocalCvDocument | null {
  const current = loadCvDocument(id);
  if (!current) {
    return null;
  }

  return createLocalCvDocument(current.data, `${current.title} Copy`);
}

export function removeCvDocument(id: string): CvDocumentLibrary {
  if (!canUseBrowserStorage()) {
    return { documents: [], activeDocumentId: null };
  }

  const index = readDocumentIndex();
  const documents = index.documents.filter((document) => document.id !== id);
  window.localStorage.removeItem(documentKey(id));
  writeDocumentIndex(documents);

  const storedActiveId = window.localStorage.getItem(ACTIVE_DOCUMENT_KEY);
  const activeDocumentId =
    storedActiveId && documents.some((document) => document.id === storedActiveId)
      ? storedActiveId
      : documents[0]?.id ?? null;

  saveActiveCvDocumentId(activeDocumentId);
  return { documents, activeDocumentId };
}

export function loadCvLibraryCollapsed() {
  if (!canUseBrowserStorage()) {
    return false;
  }

  return window.localStorage.getItem(LIBRARY_COLLAPSED_KEY) === "true";
}

export function storeCvLibraryCollapsed(collapsed: boolean) {
  if (!canUseBrowserStorage()) {
    return;
  }

  window.localStorage.setItem(LIBRARY_COLLAPSED_KEY, collapsed ? "true" : "false");
}
