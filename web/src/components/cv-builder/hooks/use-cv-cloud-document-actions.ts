import { cloudCacheScope } from "@/lib/supabase/app-context";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useTranslations } from "next-intl";
import type { EncryptionSubmitPayload } from "@/components/cv-builder/hooks/use-encryption-modal";
import { assertExistingCloudWriteCurrent, loadEncryptedCloudCvDocument, rebindExistingCloudWriteToLoadedDocument, type CloudCvDocument, type CloudCvWriteToken, type EncryptedCloudCvDocument } from "@/lib/cv/cloud-storage";
import { errorMessage } from "@/lib/cv/cv-utils";
import { decryptCvData, encryptCvData, encryptedPayloadSchema } from "@/lib/cv/encryption";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { storeEncryptionPassword, storeTrustDevice } from "@/lib/cv/encryption-storage";
import type { CloudStatus } from "@/components/cv-builder/hooks/use-cloud-session";
import type { CvData } from "@/lib/cv/schema";
import { loadCvDocument, removeCvDocument, type CvDocumentSummary } from "@/lib/cv/storage";
type CloudActionTermsGate = {
  ensure: (client?: SupabaseClient | null) => Promise<boolean>;
};
type SetOrderedDocuments = (documents: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[])) => void;
export function useCvCloudDocumentActions({
  locale = defaultLocale,
  tCloudActions,
  activeDocumentId,
  closeEncryptionModal,
  createCloudDocument,
  createEncryptedCloudDocument,
  captureExistingWrite,
  documents,
  duplicateDocument,
  encryptExistingCloudDocument,
  fetchCloudDocument,
  loadDataIntoForm,
  onError,
  openEnableEncryptionModal,
  saveCurrentDocument,
  session,
  setCloudStatus,
  setOrderedDocuments,
  supabase,
  termsGate,
  upsertDocumentSummary
}: {
  locale?: Locale;
  tCloudActions: ReturnType<typeof useTranslations<"CvCloudActions">>;
  activeDocumentId: string | null;
  closeEncryptionModal: () => void;
  createCloudDocument: (input: {
    client: SupabaseClient;
    data: CvData;
    title: string;
    sourceDocumentId?: string;
    expectedUserId: string;
  }) => Promise<CloudCvDocument>;
  createEncryptedCloudDocument: (input: {
    client: SupabaseClient;
    encryptedPayload: EncryptedPayload;
    schemaVersion: number;
    title: string;
    sourceDocumentId?: string;
    expectedUserId: string;
  }) => Promise<EncryptedCloudCvDocument>;
  captureExistingWrite: (id: string) => CloudCvWriteToken;
  documents: CvDocumentSummary[];
  duplicateDocument: (id: string, options?: {
    passphraseOverride?: string;
    title?: string;
  }) => Promise<void>;
  encryptExistingCloudDocument: (input: {
    client: SupabaseClient;
    expectedUserId: string;
    writeToken: CloudCvWriteToken;
    encryptedPayload: EncryptedPayload;
    id: string;
    schemaVersion: number;
  }) => Promise<EncryptedCloudCvDocument>;
  fetchCloudDocument: (client: SupabaseClient, id: string, locale: Locale) => Promise<CloudCvDocument>;
  loadDataIntoForm: (id: string, data: CvData, options?: { cloudRevision?: string }) => void;
  onError: (message: string) => void;
  openEnableEncryptionModal: (documentId: string) => void;
  saveCurrentDocument: (options?: {
    silent?: boolean;
  }) => Promise<boolean>;
  session: Session | null;
  setCloudStatus: Dispatch<SetStateAction<CloudStatus>>;
  setOrderedDocuments: SetOrderedDocuments;
  supabase: SupabaseClient | null;
  termsGate: CloudActionTermsGate;
  upsertDocumentSummary: (summary: CvDocumentSummary) => void;
}) {
  const actor = useRef({
    userId: session?.user.id,
    activeDocumentId,
    owner: {}
  });
  useLayoutEffect(() => {
    const userId = session?.user.id;
    actor.current = {
      userId,
      activeDocumentId,
      owner: actor.current.userId === userId ? actor.current.owner : {}
    };
  }, [session?.user.id, activeDocumentId]);
  function actorGuard(includeDocument = true) {
    const start = actor.current;
    return () => actor.current.owner === start.owner && actor.current.userId === session?.user.id && (!includeDocument || actor.current.activeDocumentId === start.activeDocumentId);
  }
  const pendingEncryptedCreates = useRef(new Map<string, {
    source: string;
    password: string;
    payload: EncryptedPayload;
  }>());
  async function moveToCloud(id: string) {
    const ownsActor = actorGuard();
    const current = documents.find(document => document.id === id);
    if (!current) return;
    if (!supabase || !session) {
      onError(tCloudActions("signInBeforeMove"));
      return;
    }
    if (!(await termsGate.ensure())) {
      return;
    }
    if (!ownsActor()) return;
    if (current.storageKind !== "local") {
      return;
    }
    try {
      if (id === activeDocumentId && !(await saveCurrentDocument({
        silent: true
      }))) {
        return;
      }
      if (!ownsActor()) return;
      const localDocument = loadCvDocument(id);
      if (!localDocument) {
        throw new Error(tCloudActions("localLoadFailed"));
      }
      const cloudDocument = await createCloudDocument({
        client: supabase,
        title: localDocument.title,
        sourceDocumentId: id,
        expectedUserId: session.user.id,
        data: localDocument.data
      });
      if (!ownsActor()) return;
      removeCvDocument(id);
      // The createCloudDocument mutation's onSuccess already upserts this new cloud doc
      // into the React Query list cache; the documentsData effect mirrors that cache into
      // documents via replaceCloudSummaries. Filter out the new cloud id as well as the
      // old local id so this prepend stays a single entry regardless of whether the mirror
      // effect has already run (avoids the duplicate-key bug seen on local->cloud moves).
      setOrderedDocuments(currentDocuments => [cloudDocument, ...currentDocuments.filter(document => document.id !== id && document.id !== cloudDocument.id)]);
      loadDataIntoForm(cloudDocument.id, cloudDocument.data, { cloudRevision: cloudDocument.revision });
      setCloudStatus("ready");
    } catch (moveError) {
      if (ownsActor()) onError(errorMessage(moveError));
    }
  }
  async function enableEncryption(id: string, password: string, trustDevice: boolean) {
    const ownsActor = actorGuard();
    const current = documents.find(document => document.id === id);
    if (!current) return;
    if (!supabase || !session) {
      onError(tCloudActions("signInBeforeEncrypt"));
      return;
    }
    if (!(await termsGate.ensure())) {
      return;
    }
    if (!ownsActor()) return;
    if (!password) {
      onError(tCloudActions("passwordRequired"));
      return;
    }
    if (current.storageKind === "encrypted") {
      return;
    }
    try {
      if (id === activeDocumentId && !(await saveCurrentDocument({
        silent: true
      }))) {
        return;
      }
      if (!ownsActor()) return;
      let writeToken = current.storageKind === "cloud" ? captureExistingWrite(id) : null;
      const sourceDocument = current.storageKind === "local" ? loadCvDocument(id) : await fetchCloudDocument(supabase, id, locale);
      if (writeToken && sourceDocument) writeToken = rebindExistingCloudWriteToLoadedDocument(writeToken, sourceDocument as CloudCvDocument);
      const sourceData = sourceDocument?.data;
      if (!ownsActor()) return;
      if (!sourceData) {
        throw new Error(tCloudActions("loadBeforeEncryptFailed"));
      }
      const operationStorageKey = `typst-cv-builder:pending-encryption:${cloudCacheScope()}:${session.user.id}:${id}`;
      const storedEnvelope = current.storageKind === "local" ? window.sessionStorage.getItem(operationStorageKey) : null;
      let pending = pendingEncryptedCreates.current.get(id);
      if (!pending && storedEnvelope) {
        const payload: unknown = JSON.parse(storedEnvelope);
        const restored = await decryptCvData(payload, password, locale);
        pending = {
          source: JSON.stringify(restored),
          password,
          payload: encryptedPayloadSchema.parse(JSON.parse(storedEnvelope))
        };
      }
      const source = JSON.stringify(sourceData);
      if (pending && (pending.source !== source || pending.password !== password)) {
        throw new Error("Confirm the pending encrypted create before changing its content or password.");
      }
      if (writeToken) assertExistingCloudWriteCurrent(writeToken);
      const encryptedPayload = pending?.payload ?? (await encryptCvData(sourceData, password, locale));
      if (!ownsActor()) return;
      if (writeToken) assertExistingCloudWriteCurrent(writeToken);
      if (current.storageKind === "local") {
        window.sessionStorage.setItem(operationStorageKey, JSON.stringify(encryptedPayload));
        pendingEncryptedCreates.current.set(id, {
          source,
          password,
          payload: encryptedPayload
        });
      }
      if (current.storageKind === "local") {
        const encryptedDocument = await createEncryptedCloudDocument({
          client: supabase,
          title: current.title,
          sourceDocumentId: id,
          expectedUserId: session.user.id,
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion
        });
        if (!ownsActor()) return;
        pendingEncryptedCreates.current.delete(id);
        window.sessionStorage.removeItem(operationStorageKey);
        removeCvDocument(id);
        if (session.user.id) {
          await storeEncryptionPassword(session.user.id, encryptedDocument.id, password, trustDevice);
          if (!ownsActor()) return;
        }
        // Dedupe against the new cloud id too (see moveToCloud): the encryption mutation's
        // onSuccess mirrors the new doc into documents via the documentsData effect, so the
        // manual prepend must not double it up regardless of execution order.
        setOrderedDocuments(currentDocuments => [encryptedDocument, ...currentDocuments.filter(document => document.id !== id && document.id !== encryptedDocument.id)]);
        loadDataIntoForm(encryptedDocument.id, sourceData, { cloudRevision: encryptedDocument.revision });
      } else {
        const encryptedDocument = await encryptExistingCloudDocument({
          client: supabase,
          expectedUserId: session.user.id,
          writeToken: writeToken!,
          id,
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion
        });
        if (!ownsActor()) return;
        upsertDocumentSummary(encryptedDocument);
        loadDataIntoForm(id, sourceData, { cloudRevision: encryptedDocument.revision });
      }
      setCloudStatus("ready");
    } catch (encryptionError) {
      if (ownsActor()) onError(errorMessage(encryptionError));
    }
  }
  async function unlockEncryptedDocument(id: string, password: string) {
    const ownsActor = actorGuard();
    if (!supabase || !session) {
      throw new Error(tCloudActions("signInBeforeOpenEncrypted"));
    }
    if (!(await termsGate.ensure())) {
      return;
    }
    if (!ownsActor()) return;
    const document = await loadEncryptedCloudCvDocument(supabase, id, locale, session.user.id);
    if (!ownsActor()) return;
    const decryptedData = await decryptCvData(document.encryptedPayload, password, locale);
    if (!ownsActor()) return;
    upsertDocumentSummary(document);
    loadDataIntoForm(document.id, decryptedData, { cloudRevision: document.revision });
  }
  async function openEnableEncryption(id: string) {
    const ownsActor = actorGuard();
    const current = documents.find(document => document.id === id);
    if (!current || current.storageKind === "encrypted") {
      return;
    }
    if (!supabase || !session) {
      onError(tCloudActions("signInBeforeEncrypt"));
      return;
    }
    if (!(await termsGate.ensure())) {
      return;
    }
    if (!ownsActor()) return;
    openEnableEncryptionModal(id);
  }
  async function handleEncryptionSubmit(payload: EncryptionSubmitPayload) {
    const ownsActor = actorGuard(false);
    const {
      mode,
      documentId,
      password,
      trustDevice
    } = payload;
    try {
      const userId = session?.user.id;
      if (userId) {
        await storeEncryptionPassword(userId, documentId, password, trustDevice);
        if (!ownsActor()) return;
        storeTrustDevice(userId, trustDevice);
      }
      if (mode === "enable") {
        await enableEncryption(documentId, password, trustDevice);
      } else if (mode === "unlock") {
        await unlockEncryptedDocument(documentId, password);
      } else {
        await duplicateDocument(documentId, {
          passphraseOverride: password
        });
      }
      if (!ownsActor()) return;
      closeEncryptionModal();
    } catch (modalError) {
      if (!ownsActor()) return;
      return {
        error: errorMessage(modalError)
      };
    }
  }
  return {
    handleEncryptionSubmit,
    moveToCloud,
    openEnableEncryption
  };
}
