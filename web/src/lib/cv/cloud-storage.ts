import type { SupabaseClient } from "@supabase/supabase-js";

import { defaultLocale, type Locale } from "@/i18n/routing";
import type { EncryptedPayload } from "./encryption";
import { persistedCvSchema, type CvData } from "./schema";
import type { CvDocumentSummary } from "./storage";

type CvDocumentRow = {
  id: string;
  title: string;
  storage_mode: "plain" | "encrypted";
  data: unknown;
  encrypted_payload: unknown;
  schema_version: number;
  created_at: string;
  updated_at: string;
};

export type CloudCvDocument = CvDocumentSummary & {
  storageKind: "cloud";
  data: CvData;
};

export type EncryptedCloudCvDocument = CvDocumentSummary & {
  storageKind: "encrypted";
  encryptedPayload: EncryptedPayload;
};

const cloudStorageMessages = {
  en: {
    encryptedNeedsUnlock: "Encrypted CVs need to be unlocked before editing.",
    schemaMismatch: "Cloud CV data does not match the current CV schema.",
    notEncrypted: "This cloud CV is not encrypted.",
    notFound: "Cloud CV was not found.",
  },
  zh: {
    encryptedNeedsUnlock: "加密简历需要先解锁才能编辑。",
    schemaMismatch: "云端简历数据不符合当前 CV schema。",
    notEncrypted: "此云端简历未加密。",
    notFound: "未找到该云端简历。",
  },
};

function getCloudStorageMessage(locale: Locale, key: keyof typeof cloudStorageMessages.en) {
  return cloudStorageMessages[locale]?.[key] ?? cloudStorageMessages.en[key];
}

const cloudDocumentColumns =
  "id,title,storage_mode,data,encrypted_payload,schema_version,created_at,updated_at";

function cloudStorageKind(row: Pick<CvDocumentRow, "storage_mode">) {
  return row.storage_mode === "encrypted" ? "encrypted" : "cloud";
}

function summaryFromCloudRow(row: CvDocumentRow): CvDocumentSummary {
  return {
    id: row.id,
    title: row.title,
    storageKind: cloudStorageKind(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function plainDocumentFromRow(row: CvDocumentRow, locale: Locale): CloudCvDocument {
  if (row.storage_mode !== "plain") {
    throw new Error(getCloudStorageMessage(locale, "encryptedNeedsUnlock"));
  }

  const parsed = persistedCvSchema.safeParse(row.data);
  if (!parsed.success) {
    throw new Error(getCloudStorageMessage(locale, "schemaMismatch"));
  }

  return {
    ...summaryFromCloudRow(row),
    storageKind: "cloud",
    data: parsed.data,
  };
}

function encryptedDocumentFromRow(row: CvDocumentRow, locale: Locale): EncryptedCloudCvDocument {
  if (row.storage_mode !== "encrypted") {
    throw new Error(getCloudStorageMessage(locale, "notEncrypted"));
  }

  return {
    ...summaryFromCloudRow(row),
    storageKind: "encrypted",
    encryptedPayload: row.encrypted_payload as EncryptedPayload,
  };
}

function requireSingleRow(row: CvDocumentRow | null, locale: Locale) {
  if (!row) {
    throw new Error(getCloudStorageMessage(locale, "notFound"));
  }

  return row;
}

export async function listCloudCvDocuments(supabase: SupabaseClient): Promise<CvDocumentSummary[]> {
  const { data, error } = await supabase
    .from("cv_documents")
    .select(cloudDocumentColumns)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return ((data ?? []) as CvDocumentRow[]).map(summaryFromCloudRow);
}

export async function loadCloudCvDocument(
  supabase: SupabaseClient,
  id: string,
  locale: Locale = defaultLocale,
): Promise<CloudCvDocument> {
  const { data, error } = await supabase
    .from("cv_documents")
    .select(cloudDocumentColumns)
    .eq("id", id)
    .single();

  if (error) {
    throw error;
  }

  return plainDocumentFromRow(requireSingleRow(data as CvDocumentRow | null, locale), locale);
}

export async function loadEncryptedCloudCvDocument(
  supabase: SupabaseClient,
  id: string,
  locale: Locale = defaultLocale,
): Promise<EncryptedCloudCvDocument> {
  const { data, error } = await supabase
    .from("cv_documents")
    .select(cloudDocumentColumns)
    .eq("id", id)
    .single();

  if (error) {
    throw error;
  }

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null, locale), locale);
}

export async function createCloudCvDocument(
  supabase: SupabaseClient,
  { title, data }: { title: string; data: CvData },
  locale: Locale = defaultLocale,
): Promise<CloudCvDocument> {
  const { data: row, error } = await supabase
    .from("cv_documents")
    .insert({
      data,
      schema_version: data.schemaVersion,
      storage_mode: "plain",
      title,
    })
    .select(cloudDocumentColumns)
    .single();

  if (error) {
    throw error;
  }

  return plainDocumentFromRow(requireSingleRow(row as CvDocumentRow | null, locale), locale);
}

export async function createEncryptedCloudCvDocument(
  supabase: SupabaseClient,
  { title, encryptedPayload, schemaVersion }: { title: string; encryptedPayload: EncryptedPayload; schemaVersion: number },
  locale: Locale = defaultLocale,
): Promise<EncryptedCloudCvDocument> {
  const { data, error } = await supabase
    .from("cv_documents")
    .insert({
      encrypted_payload: encryptedPayload,
      schema_version: schemaVersion,
      storage_mode: "encrypted",
      title,
    })
    .select(cloudDocumentColumns)
    .single();

  if (error) {
    throw error;
  }

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null, locale), locale);
}

export async function updateCloudCvDocumentData(
  supabase: SupabaseClient,
  id: string,
  data: CvData,
  locale: Locale = defaultLocale,
): Promise<CloudCvDocument> {
  const { data: row, error } = await supabase
    .from("cv_documents")
    .update({
      data,
      schema_version: data.schemaVersion,
    })
    .eq("id", id)
    .eq("storage_mode", "plain")
    .select(cloudDocumentColumns)
    .single();

  if (error) {
    throw error;
  }

  return plainDocumentFromRow(requireSingleRow(row as CvDocumentRow | null, locale), locale);
}

export async function updateEncryptedCloudCvDocumentData(
  supabase: SupabaseClient,
  id: string,
  { encryptedPayload, schemaVersion }: { encryptedPayload: EncryptedPayload; schemaVersion: number },
  locale: Locale = defaultLocale,
): Promise<EncryptedCloudCvDocument> {
  const { data, error } = await supabase
    .from("cv_documents")
    .update({
      encrypted_payload: encryptedPayload,
      schema_version: schemaVersion,
    })
    .eq("id", id)
    .eq("storage_mode", "encrypted")
    .select(cloudDocumentColumns)
    .single();

  if (error) {
    throw error;
  }

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null, locale), locale);
}

export async function encryptExistingCloudCvDocument(
  supabase: SupabaseClient,
  id: string,
  { encryptedPayload, schemaVersion }: { encryptedPayload: EncryptedPayload; schemaVersion: number },
  locale: Locale = defaultLocale,
): Promise<EncryptedCloudCvDocument> {
  const { data, error } = await supabase
    .from("cv_documents")
    .update({
      data: null,
      encrypted_payload: encryptedPayload,
      schema_version: schemaVersion,
      storage_mode: "encrypted",
    })
    .eq("id", id)
    .eq("storage_mode", "plain")
    .select(cloudDocumentColumns)
    .single();

  if (error) {
    throw error;
  }

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null, locale), locale);
}

export async function renameCloudCvDocument(
  supabase: SupabaseClient,
  id: string,
  title: string,
): Promise<CvDocumentSummary> {
  const { data, error } = await supabase
    .from("cv_documents")
    .update({ title })
    .eq("id", id)
    .select(cloudDocumentColumns)
    .single();

  if (error) {
    throw error;
  }

  return summaryFromCloudRow(requireSingleRow(data as CvDocumentRow | null, defaultLocale));
}

export async function deleteCloudCvDocument(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("cv_documents").delete().eq("id", id);

  if (error) {
    throw error;
  }
}
