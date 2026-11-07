import { bindSupabaseUser } from "@/lib/supabase/user-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { clientWriteContext, requireAppContext, cloudCacheScope } from "@/lib/supabase/app-context";
import { encryptedPayloadSchema, type EncryptedPayload } from "./encryption";
import { cvSchema, type CvData } from "./schema";
import type { CvDocumentSummary } from "./storage";
const rowSchema = z.object({
  external_id: z.string().regex(/^cv_[0-9A-HJKMNP-TV-Z]{12}$/),
  title: z.string(),
  storage_mode: z.enum(["PLAIN", "ENCRYPTED"]),
  document_schema_version: z.literal(7),
  revision: z.string().regex(/^[1-9][0-9]*$/),
  time_created: z.string(),
  time_updated: z.string(),
  data: z.unknown().optional(),
  encrypted_payload: z.unknown().optional()
});
type Row = z.infer<typeof rowSchema>;
export type CloudCvDocument = CvDocumentSummary & {
  storageKind: "cloud";
  data: CvData;
};
export type EncryptedCloudCvDocument = CvDocumentSummary & {
  storageKind: "encrypted";
  encryptedPayload: EncryptedPayload;
};
type Evidence = {
  owner: string;
  revision: string;
  instance: string;
};
const evidence = new WeakMap<SupabaseClient, Map<string, Evidence>>();
const editingEvidence = new WeakMap<SupabaseClient, Map<string, Evidence>>();
const pendingCreates = new WeakMap<SupabaseClient, Map<string, string>>();
const summaryColumns = "external_id,title,storage_mode,document_schema_version,revision,time_created,time_updated";
async function scopedClient(client: SupabaseClient, expectedUserId?: string) {
  const {
    data,
    error
  } = await client.auth.getSession();
  if (error) throw error;
  const userId = data.session?.user.id;
  if (!userId || expectedUserId && userId !== expectedUserId) throw new Error("CONFLICT: ACCOUNT_CHANGED");
  return {
    scoped: await bindSupabaseUser(client, userId),
    userId
  };
}
function remember(client: SupabaseClient, row: Row, instance: string, owner: string) {
  let rows = evidence.get(client);
  if (!rows) {
    rows = new Map();
    evidence.set(client, rows);
  }
  rows.set(row.external_id, {
    owner,
    revision: row.revision,
    instance
  });
}
export function cloudDocumentOwner(client: SupabaseClient, id: string) {
  return evidence.get(client)?.get(id)?.owner ?? null;
}
export function editingCloudRevision(client: SupabaseClient, id: string) {
  return editingEvidence.get(client)?.get(id)?.revision ?? null;
}
/** Called only when the form actually adopts a loaded document, never by a background refetch. */
export function activateCloudDocument(client: SupabaseClient, id: string, expectedRevision?: string) {
  const current = evidence.get(client)?.get(id);
  if (!current) return;
  let editing = editingEvidence.get(client);
  if (!editing) {
    editing = new Map();
    editingEvidence.set(client, editing);
  }
  editing.clear();
  editing.set(id, expectedRevision ? {
    ...current,
    revision: expectedRevision
  } : current);
}
function summary(row: Row): CvDocumentSummary {
  return {
    id: row.external_id,
    title: row.title,
    storageKind: row.storage_mode === "PLAIN" ? "cloud" : "encrypted",
    createdAt: row.time_created,
    updatedAt: row.time_updated
  };
}
function plain(row: Row, locale: Locale): CloudCvDocument {
  if (row.storage_mode !== "PLAIN") throw new Error(locale === "zh" ? "加密简历需要先解锁才能编辑。" : "Encrypted CVs must be unlocked before editing.");
  return {
    ...summary(row),
    storageKind: "cloud",
    data: cvSchema.parse(row.data)
  };
}
function encrypted(row: Row, locale: Locale): EncryptedCloudCvDocument {
  if (row.storage_mode !== "ENCRYPTED") throw new Error(locale === "zh" ? "此云端简历未加密。" : "This CV is not encrypted.");
  return {
    ...summary(row),
    storageKind: "encrypted",
    encryptedPayload: encryptedPayloadSchema.parse(row.encrypted_payload)
  };
}
async function load(client: SupabaseClient, id: string, expectedUserId?: string) {
  const {
    scoped,
    userId
  } = await scopedClient(client, expectedUserId);
  const context = await requireAppContext(client);
  const {
    data,
    error
  } = await scoped.from("cv_document_contents").select(`${summaryColumns},data,encrypted_payload`).eq("external_id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Cloud CV was not found.");
  const row = rowSchema.parse(data);
  remember(client, row, context.database_instance_id, userId);
  return row;
}
export async function listCloudCvDocuments(client: SupabaseClient, expectedUserId?: string): Promise<CvDocumentSummary[]> {
  const {
    scoped,
    userId
  } = await scopedClient(client, expectedUserId);
  const context = await requireAppContext(client);
  const {
    data,
    error
  } = await scoped.from("cv_document_summaries").select(summaryColumns).order("time_updated", {
    ascending: false
  });
  if (error) throw error;
  return z.array(rowSchema).parse(data).map(row => {
    // List refreshes must not advance the edit baseline of an already loaded document.
    remember(client, row, context.database_instance_id, userId);
    return summary(row);
  });
}
export async function loadCloudCvDocument(client: SupabaseClient, id: string, _locale: Locale = defaultLocale, expectedUserId?: string) {
  return plain(await load(client, id, expectedUserId), _locale);
}
export async function loadEncryptedCloudCvDocument(client: SupabaseClient, id: string, _locale: Locale = defaultLocale, expectedUserId?: string) {
  return encrypted(await load(client, id, expectedUserId), _locale);
}
type CvMutation = "cv_document_create" | "cv_document_update" | "cv_document_convert" | "cv_document_rename" | "cv_document_delete";
function requireWriteUserId(expectedUserId: string): string {
  if (typeof expectedUserId !== "string" || !expectedUserId) throw new Error("CONFLICT: Expected account is required");
  return expectedUserId;
}
async function write(client: SupabaseClient, name: CvMutation, input: Record<string, unknown>, id: string | undefined, expectedUserId: string) {
  const {
    scoped,
    userId
  } = await scopedClient(client, requireWriteUserId(expectedUserId));
  const context = await clientWriteContext(client, userId);
  const previous = id ? editingEvidence.get(client)?.get(id) ?? evidence.get(client)?.get(id) : undefined;
  if (id && (!previous || previous.instance !== context.database_instance_id)) throw new Error("CONFLICT: Open the current document before changing it.");
  const payload = {
    ...input,
    ...context,
    ...(id ? {
      external_id: id,
      expected_revision: previous!.revision
    } : {})
  };
  const {
    data,
    error
  } = await scoped.rpc(name, {
    p_input: z.json().parse(JSON.parse(JSON.stringify(payload)))
  });
  // A lost response leaves the baseline unchanged. The next write conflicts until the user reads back.
  if (error) throw error;
  if (name === "cv_document_delete") {
    evidence.get(client)?.delete(id!);
    editingEvidence.get(client)?.delete(id!);
    return null;
  }
  const row = rowSchema.parse(data);
  remember(client, row, context.database_instance_id, userId);
  if (id && editingEvidence.get(client)?.has(id)) activateCloudDocument(client, row.external_id);
  return row;
}
async function create(client: SupabaseClient, input: Record<string, unknown>, sourceDocumentId: string | undefined, expectedUserId: string) {
  const {
    userId
  } = await scopedClient(client, requireWriteUserId(expectedUserId));
  await requireAppContext(client);
  let pending = pendingCreates.get(client);
  if (!pending) {
    pending = new Map();
    pendingCreates.set(client, pending);
  }
  const payload = JSON.stringify(input);
  let storageKey: string | null = null;
  let digest = payload;
  if (typeof window !== "undefined") {
    const {
      data,
      error
    } = await client.auth.getUser();
    if (error) throw error;
    if (!data.user || data.user.id !== userId) throw new Error("CONFLICT: ACCOUNT_CHANGED");
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    digest = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
    storageKey = `typst-cv-builder:pending-create:${cloudCacheScope()}:${data.user.id}:${sourceDocumentId ? `source:${encodeURIComponent(sourceDocumentId)}` : digest}`;
  }
  const raw = storageKey ? window.sessionStorage.getItem(storageKey) : null;
  const stored = raw ? z.strictObject({
    key: z.uuid(),
    digest: z.string()
  }).parse(JSON.parse(raw)) : null;
  if (stored && stored.digest !== digest) throw new Error("CONFLICT: Resolve the pending cloud create before changing its content.");
  const key = stored?.key ?? pending.get(sourceDocumentId ?? payload) ?? crypto.randomUUID();
  // Persist before sending; the same local source retains one operation across reloads.
  if (storageKey) window.sessionStorage.setItem(storageKey, JSON.stringify({
    key,
    digest
  }));
  pending.set(sourceDocumentId ?? payload, key);
  const row = await write(client, "cv_document_create", {
    ...input,
    client_create_key: key
  }, undefined, userId);
  pending.delete(sourceDocumentId ?? payload);
  if (storageKey) window.sessionStorage.removeItem(storageKey);
  return row!;
}
export async function createCloudCvDocument(client: SupabaseClient, {
  title,
  data,
  sourceDocumentId,
  expectedUserId
}: {
  title: string;
  data: CvData;
  sourceDocumentId?: string;
  expectedUserId: string;
}, _locale: Locale = defaultLocale) {
  return plain(await create(client, {
    title,
    data: cvSchema.parse(data),
    storage_mode: "PLAIN",
    document_schema_version: 7
  }, sourceDocumentId, expectedUserId), _locale);
}
export async function createEncryptedCloudCvDocument(client: SupabaseClient, {
  title,
  encryptedPayload,
  schemaVersion,
  sourceDocumentId,
  expectedUserId
}: {
  title: string;
  encryptedPayload: EncryptedPayload;
  schemaVersion: number;
  sourceDocumentId?: string;
  expectedUserId: string;
}, _locale: Locale = defaultLocale) {
  z.literal(7).parse(schemaVersion);
  return encrypted(await create(client, {
    title,
    encrypted_payload: encryptedPayloadSchema.parse(encryptedPayload),
    storage_mode: "ENCRYPTED",
    document_schema_version: 7
  }, sourceDocumentId, expectedUserId), _locale);
}
export async function updateCloudCvDocumentData(client: SupabaseClient, id: string, data: CvData, expectedUserId: string, _locale: Locale = defaultLocale) {
  return plain((await write(client, "cv_document_update", {
    data: cvSchema.parse(data),
    storage_mode: "PLAIN",
    document_schema_version: 7
  }, id, expectedUserId))!, _locale);
}
export async function updateEncryptedCloudCvDocumentData(client: SupabaseClient, id: string, {
  encryptedPayload,
  schemaVersion,
  expectedUserId
}: {
  encryptedPayload: EncryptedPayload;
  schemaVersion: number;
  expectedUserId: string;
}, _locale: Locale = defaultLocale) {
  z.literal(7).parse(schemaVersion);
  return encrypted((await write(client, "cv_document_update", {
    encrypted_payload: encryptedPayloadSchema.parse(encryptedPayload),
    storage_mode: "ENCRYPTED",
    document_schema_version: 7
  }, id, expectedUserId))!, _locale);
}
export async function encryptExistingCloudCvDocument(client: SupabaseClient, id: string, {
  encryptedPayload,
  schemaVersion,
  expectedUserId
}: {
  encryptedPayload: EncryptedPayload;
  schemaVersion: number;
  expectedUserId: string;
}, _locale: Locale = defaultLocale) {
  z.literal(7).parse(schemaVersion);
  return encrypted((await write(client, "cv_document_convert", {
    encrypted_payload: encryptedPayloadSchema.parse(encryptedPayload),
    storage_mode: "ENCRYPTED",
    document_schema_version: 7
  }, id, expectedUserId))!, _locale);
}
export async function renameCloudCvDocument(client: SupabaseClient, id: string, title: string, expectedUserId: string) {
  return summary((await write(client, "cv_document_rename", {
    title
  }, id, expectedUserId))!);
}
export async function deleteCloudCvDocument(client: SupabaseClient, id: string, expectedUserId: string) {
  await write(client, "cv_document_delete", {}, id, expectedUserId);
}
