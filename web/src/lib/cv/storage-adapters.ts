import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type CloudCvDocument,
  type CloudCvWriteToken,
  loadEncryptedCloudCvDocument,
} from "@/lib/cv/cloud-storage";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { summarizeLocalDocument } from "@/lib/cv/cv-utils";
import { decryptCvData, encryptCvData, type EncryptedPayload } from "@/lib/cv/encryption";
import type { CvData } from "@/lib/cv/schema";
import {
  loadCvDocument,
  removeCvDocument,
  renameCvDocument,
  type CvDocumentSummary,
  type CvStorageKind,
  updateLocalCvDocumentData,
} from "@/lib/cv/storage";

const storageErrorMessages = {
  en: {
    missingPassphrase: "Enter the encryption password to unlock this CV.",
    termsNotAccepted: "Accept the current terms before using cloud storage.",
    localLoadFailed: "The selected local CV could not be loaded.",
    renameFailed: "The selected CV could not be renamed.",
    saveFailed: "The active CV could not be saved.",
  },
  zh: {
    missingPassphrase: "请输入加密密码以解锁此简历。",
    termsNotAccepted: "使用云端存储前请先接受当前条款。",
    localLoadFailed: "无法加载选中的本地简历。",
    renameFailed: "无法重命名选中的简历。",
    saveFailed: "无法保存当前简历。",
  },
};

function getStorageErrorMessage(locale: Locale, key: keyof typeof storageErrorMessages.en) {
  return storageErrorMessages[locale]?.[key] ?? storageErrorMessages.en[key];
}

export class MissingPassphraseError extends Error {
  constructor(public readonly documentId: string, locale: Locale = defaultLocale) {
    super(getStorageErrorMessage(locale, "missingPassphrase"));
    this.name = "MissingPassphraseError";
  }
}

export class TermsNotAcceptedError extends Error {
  constructor(locale: Locale = defaultLocale) {
    super(getStorageErrorMessage(locale, "termsNotAccepted"));
    this.name = "TermsNotAcceptedError";
  }
}

export function isMissingPassphraseError(error: unknown): error is MissingPassphraseError {
  return error instanceof MissingPassphraseError;
}

export function isTermsNotAcceptedError(error: unknown): error is TermsNotAcceptedError {
  return error instanceof TermsNotAcceptedError;
}

export type LoadedCvDocument = {
  data: CvData;
} & ({
  summary: CvDocumentSummary & { storageKind: "local" };
  cloudRevision?: never;
} | {
  summary: CvDocumentSummary & { storageKind: "cloud" | "encrypted" };
  cloudRevision: string;
});

type LoadOptions = {
  passphraseOverride?: string;
};

type CvStorageAdapter = {
  delete(summary: CvDocumentSummary): Promise<void>;
  load(summary: CvDocumentSummary, options?: LoadOptions): Promise<LoadedCvDocument>;
  rename(summary: CvDocumentSummary, title: string): Promise<CvDocumentSummary>;
  save(summary: CvDocumentSummary, data: CvData): Promise<CvDocumentSummary>;
};

export type CvStorageAdapters = Record<CvStorageKind, CvStorageAdapter>;

type EncryptedUpdate = {
  encryptedPayload: EncryptedPayload;
  schemaVersion: number;
};

export type CvCloudStorageOperations = {
  deleteCloudDocument(client: SupabaseClient, id: string, writeToken: CloudCvWriteToken): Promise<void>;
  loadCloudDocument(client: SupabaseClient, id: string, locale: Locale): Promise<CloudCvDocument>;
  renameCloudDocument(client: SupabaseClient, id: string, title: string, writeToken: CloudCvWriteToken): Promise<CvDocumentSummary>;
  updateCloudDocumentData(client: SupabaseClient, id: string, data: CvData, locale: Locale, writeToken: CloudCvWriteToken): Promise<CvDocumentSummary>;
  updateEncryptedCloudDocumentData(
    client: SupabaseClient,
    id: string,
    update: EncryptedUpdate,
    locale: Locale,
    writeToken: CloudCvWriteToken,
  ): Promise<CvDocumentSummary>;
};

export type CvCloudAccessAction =
  | "signInBeforeDeleteCloud"
  | "signInBeforeOpenCloud"
  | "signInBeforeRenameCloud"
  | "signInBeforeSaveCloud"
  | "signInBeforeOpenEncrypted"
  | "signInBeforeSaveEncrypted";

export function createCvStorageAdapters({
  locale = defaultLocale,
  cloudStorage,
  captureExistingWrite,
  getEncryptionPassphrase,
  requireCloudAccess,
}: {
  locale?: Locale;
  cloudStorage: CvCloudStorageOperations;
  captureExistingWrite: (id: string) => CloudCvWriteToken;
  getEncryptionPassphrase: (id: string) => Promise<string | null>;
  requireCloudAccess: (action: CvCloudAccessAction) => Promise<SupabaseClient>;
}): CvStorageAdapters {
  async function requirePassphrase(id: string, override?: string) {
    const passphrase = override ?? (await getEncryptionPassphrase(id));
    if (!passphrase) {
      throw new MissingPassphraseError(id, locale);
    }

    return passphrase;
  }

  return {
    local: {
      async delete(summary) {
        removeCvDocument(summary.id);
      },
      async load(summary) {
        const document = loadCvDocument(summary.id);
        if (!document) {
          throw new Error(getStorageErrorMessage(locale, "localLoadFailed"));
        }

        return {
          data: document.data,
          summary: { ...summarizeLocalDocument(document), storageKind: "local" as const },
        };
      },
      async rename(summary, title) {
        const updatedDocuments = renameCvDocument(summary.id, title);
        const updated = updatedDocuments.find((document) => document.id === summary.id);
        if (!updated) {
          throw new Error(getStorageErrorMessage(locale, "renameFailed"));
        }

        return updated;
      },
      async save(summary, data) {
        const updated = updateLocalCvDocumentData(summary.id, data);
        if (!updated) {
          throw new Error(getStorageErrorMessage(locale, "saveFailed"));
        }

        return summarizeLocalDocument(updated);
      },
    },
    cloud: {
      async delete(summary) {
        const writeToken = captureExistingWrite(summary.id);
        const client = await requireCloudAccess("signInBeforeDeleteCloud");
        await cloudStorage.deleteCloudDocument(client, summary.id, writeToken);
      },
      async load(summary) {
        const client = await requireCloudAccess("signInBeforeOpenCloud");
        const document = await cloudStorage.loadCloudDocument(client, summary.id, locale);
        return {
          data: document.data,
          summary: document,
          cloudRevision: document.revision,
        };
      },
      async rename(summary, title) {
        const writeToken = captureExistingWrite(summary.id);
        const client = await requireCloudAccess("signInBeforeRenameCloud");
        return cloudStorage.renameCloudDocument(client, summary.id, title, writeToken);
      },
      async save(summary, data) {
        const writeToken = captureExistingWrite(summary.id);
        const client = await requireCloudAccess("signInBeforeSaveCloud");
        return cloudStorage.updateCloudDocumentData(client, summary.id, data, locale, writeToken);
      },
    },
    encrypted: {
      async delete(summary) {
        const writeToken = captureExistingWrite(summary.id);
        const client = await requireCloudAccess("signInBeforeDeleteCloud");
        await cloudStorage.deleteCloudDocument(client, summary.id, writeToken);
      },
      async load(summary, options) {
        const client = await requireCloudAccess("signInBeforeOpenEncrypted");
        const passphrase = await requirePassphrase(summary.id, options?.passphraseOverride);
        const document = await loadEncryptedCloudCvDocument(client, summary.id, locale);
        return {
          data: await decryptCvData(document.encryptedPayload, passphrase, locale),
          summary: document,
          cloudRevision: document.revision,
        };
      },
      async rename(summary, title) {
        const writeToken = captureExistingWrite(summary.id);
        const client = await requireCloudAccess("signInBeforeRenameCloud");
        return cloudStorage.renameCloudDocument(client, summary.id, title, writeToken);
      },
      async save(summary, data) {
        const writeToken = captureExistingWrite(summary.id);
        const client = await requireCloudAccess("signInBeforeSaveEncrypted");
        const passphrase = await requirePassphrase(summary.id);
        const encryptedPayload = await encryptCvData(data, passphrase, locale);
        return cloudStorage.updateEncryptedCloudDocumentData(client, summary.id, {
          encryptedPayload,
          schemaVersion: data.schemaVersion,
        }, locale, writeToken);
      },
    },
  };
}
