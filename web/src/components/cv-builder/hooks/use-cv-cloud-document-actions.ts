import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { Dispatch, SetStateAction } from "react";
import { useTranslations } from "next-intl";

import type { EncryptionSubmitPayload } from "@/components/cv-builder/hooks/use-encryption-modal";
import { loadEncryptedCloudCvDocument, type CloudCvDocument, type EncryptedCloudCvDocument } from "@/lib/cv/cloud-storage";
import { errorMessage } from "@/lib/cv/cv-utils";
import { decryptCvData, encryptCvData } from "@/lib/cv/encryption";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { storeEncryptionPassword, storeTrustDevice } from "@/lib/cv/encryption-storage";
import type { CloudStatus } from "@/components/cv-builder/hooks/use-cloud-session";
import type { CvData } from "@/lib/cv/schema";
import {
  loadCvDocument,
  removeCvDocument,
  type CvDocumentSummary,
} from "@/lib/cv/storage";

type CloudActionTermsGate = {
  ensure: (client?: SupabaseClient | null) => Promise<boolean>;
};

type SetOrderedDocuments = (
  documents: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[]),
) => void;

export function useCvCloudDocumentActions({
  locale = defaultLocale,
  tCloudActions,
  activeDocumentId,
  closeEncryptionModal,
  createCloudDocument,
  createEncryptedCloudDocument,
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
  upsertDocumentSummary,
}: {
  locale?: Locale;
  tCloudActions: ReturnType<typeof useTranslations<"CvCloudActions">>;
  activeDocumentId: string | null;
  closeEncryptionModal: () => void;
  createCloudDocument: (input: {
    client: SupabaseClient;
    data: CvData;
    title: string;
  }) => Promise<CloudCvDocument>;
  createEncryptedCloudDocument: (input: {
    client: SupabaseClient;
    encryptedPayload: EncryptedPayload;
    schemaVersion: number;
    title: string;
  }) => Promise<EncryptedCloudCvDocument>;
  documents: CvDocumentSummary[];
  duplicateDocument: (id: string, passphraseOverride?: string) => Promise<void>;
  encryptExistingCloudDocument: (input: {
    client: SupabaseClient;
    encryptedPayload: EncryptedPayload;
    id: string;
    schemaVersion: number;
  }) => Promise<EncryptedCloudCvDocument>;
  fetchCloudDocument: (client: SupabaseClient, id: string, locale: Locale) => Promise<CloudCvDocument>;
  loadDataIntoForm: (id: string, data: CvData) => void;
  onError: (message: string) => void;
  openEnableEncryptionModal: (documentId: string) => void;
  saveCurrentDocument: (options?: { silent?: boolean }) => Promise<boolean>;
  session: Session | null;
  setCloudStatus: Dispatch<SetStateAction<CloudStatus>>;
  setOrderedDocuments: SetOrderedDocuments;
  supabase: SupabaseClient | null;
  termsGate: CloudActionTermsGate;
  upsertDocumentSummary: (summary: CvDocumentSummary) => void;
}) {
  async function moveToCloud(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    if (!supabase || !session) {
      onError(tCloudActions("signInBeforeMove"));
      return;
    }

    if (!(await termsGate.ensure())) {
      return;
    }

    if (current.storageKind !== "local") {
      return;
    }

    try {
      if (id === activeDocumentId && !(await saveCurrentDocument({ silent: true }))) {
        return;
      }

      const localDocument = loadCvDocument(id);
      if (!localDocument) {
        throw new Error(tCloudActions("localLoadFailed"));
      }

      const cloudDocument = await createCloudDocument({
        client: supabase,
        title: localDocument.title,
        data: localDocument.data,
      });
      removeCvDocument(id);
      setOrderedDocuments((currentDocuments) => [
        cloudDocument,
        ...currentDocuments.filter((document) => document.id !== id),
      ]);
      loadDataIntoForm(cloudDocument.id, cloudDocument.data);
      setCloudStatus("ready");
    } catch (moveError) {
      onError(errorMessage(moveError));
    }
  }

  async function enableEncryption(id: string, password: string, trustDevice: boolean) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    if (!supabase || !session) {
      onError(tCloudActions("signInBeforeEncrypt"));
      return;
    }

    if (!(await termsGate.ensure())) {
      return;
    }

    if (!password) {
      onError(tCloudActions("passwordRequired"));
      return;
    }

    if (current.storageKind === "encrypted") {
      return;
    }

    try {
      if (id === activeDocumentId && !(await saveCurrentDocument({ silent: true }))) {
        return;
      }

      const sourceData =
        current.storageKind === "local"
          ? loadCvDocument(id)?.data
          : (await fetchCloudDocument(supabase, id, locale)).data;

      if (!sourceData) {
        throw new Error(tCloudActions("loadBeforeEncryptFailed"));
      }

      const encryptedPayload = await encryptCvData(sourceData, password, locale);

      if (current.storageKind === "local") {
        const encryptedDocument = await createEncryptedCloudDocument({
          client: supabase,
          title: current.title,
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion,
        });
        removeCvDocument(id);
        if (session.user.id) {
          storeEncryptionPassword(session.user.id, encryptedDocument.id, password, trustDevice);
        }
        setOrderedDocuments((currentDocuments) => [
          encryptedDocument,
          ...currentDocuments.filter((document) => document.id !== id),
        ]);
        loadDataIntoForm(encryptedDocument.id, sourceData);
      } else {
        const encryptedDocument = await encryptExistingCloudDocument({
          client: supabase,
          id,
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion,
        });
        upsertDocumentSummary(encryptedDocument);
        loadDataIntoForm(id, sourceData);
      }

      setCloudStatus("ready");
    } catch (encryptionError) {
      onError(errorMessage(encryptionError));
    }
  }

  async function unlockEncryptedDocument(id: string, password: string) {
    if (!supabase || !session) {
      throw new Error(tCloudActions("signInBeforeOpenEncrypted"));
    }

    if (!(await termsGate.ensure())) {
      return;
    }

    const document = await loadEncryptedCloudCvDocument(supabase, id, locale);
    const decryptedData = await decryptCvData(document.encryptedPayload, password, locale);
    upsertDocumentSummary(document);
    loadDataIntoForm(document.id, decryptedData);
  }

  async function openEnableEncryption(id: string) {
    const current = documents.find((document) => document.id === id);
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

    openEnableEncryptionModal(id);
  }

  async function handleEncryptionSubmit(payload: EncryptionSubmitPayload) {
    const { mode, documentId, password, trustDevice } = payload;

    try {
      const userId = session?.user.id;
      if (userId) {
        storeEncryptionPassword(userId, documentId, password, trustDevice);
        storeTrustDevice(userId, trustDevice);
      }

      if (mode === "enable") {
        await enableEncryption(documentId, password, trustDevice);
      } else if (mode === "unlock") {
        await unlockEncryptedDocument(documentId, password);
      } else {
        await duplicateDocument(documentId, password);
      }

      closeEncryptionModal();
    } catch (modalError) {
      return { error: errorMessage(modalError) };
    }
  }

  return {
    handleEncryptionSubmit,
    moveToCloud,
    openEnableEncryption,
  };
}
