import type { SupabaseClient } from "@supabase/supabase-js";

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

function plainDocumentFromRow(row: CvDocumentRow): CloudCvDocument {
  if (row.storage_mode !== "plain") {
    throw new Error("Encrypted CVs need to be unlocked before editing.");
  }

  const parsed = persistedCvSchema.safeParse(row.data);
  if (!parsed.success) {
    throw new Error("Cloud CV data does not match the current CV schema.");
  }

  return {
    ...summaryFromCloudRow(row),
    storageKind: "cloud",
    data: parsed.data,
  };
}

function encryptedDocumentFromRow(row: CvDocumentRow): EncryptedCloudCvDocument {
  if (row.storage_mode !== "encrypted") {
    throw new Error("This cloud CV is not encrypted.");
  }

  return {
    ...summaryFromCloudRow(row),
    storageKind: "encrypted",
    encryptedPayload: row.encrypted_payload as EncryptedPayload,
  };
}

function requireSingleRow(row: CvDocumentRow | null) {
  if (!row) {
    throw new Error("Cloud CV was not found.");
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
): Promise<CloudCvDocument> {
  const { data, error } = await supabase
    .from("cv_documents")
    .select(cloudDocumentColumns)
    .eq("id", id)
    .single();

  if (error) {
    throw error;
  }

  return plainDocumentFromRow(requireSingleRow(data as CvDocumentRow | null));
}

export async function loadEncryptedCloudCvDocument(
  supabase: SupabaseClient,
  id: string,
): Promise<EncryptedCloudCvDocument> {
  const { data, error } = await supabase
    .from("cv_documents")
    .select(cloudDocumentColumns)
    .eq("id", id)
    .single();

  if (error) {
    throw error;
  }

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null));
}

export async function createCloudCvDocument(
  supabase: SupabaseClient,
  { title, data }: { title: string; data: CvData },
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

  return plainDocumentFromRow(requireSingleRow(row as CvDocumentRow | null));
}

export async function createEncryptedCloudCvDocument(
  supabase: SupabaseClient,
  { title, encryptedPayload, schemaVersion }: { title: string; encryptedPayload: EncryptedPayload; schemaVersion: number },
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

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null));
}

export async function updateCloudCvDocumentData(
  supabase: SupabaseClient,
  id: string,
  data: CvData,
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

  return plainDocumentFromRow(requireSingleRow(row as CvDocumentRow | null));
}

export async function updateEncryptedCloudCvDocumentData(
  supabase: SupabaseClient,
  id: string,
  { encryptedPayload, schemaVersion }: { encryptedPayload: EncryptedPayload; schemaVersion: number },
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

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null));
}

export async function encryptExistingCloudCvDocument(
  supabase: SupabaseClient,
  id: string,
  { encryptedPayload, schemaVersion }: { encryptedPayload: EncryptedPayload; schemaVersion: number },
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

  return encryptedDocumentFromRow(requireSingleRow(data as CvDocumentRow | null));
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

  return summaryFromCloudRow(requireSingleRow(data as CvDocumentRow | null));
}

export async function deleteCloudCvDocument(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("cv_documents").delete().eq("id", id);

  if (error) {
    throw error;
  }
}
