import type { SupabaseClient } from "@supabase/supabase-js";

import {
  deleteCloudCvDocument,
  loadCloudCvDocument,
  loadEncryptedCloudCvDocument,
  renameCloudCvDocument,
  updateCloudCvDocumentData,
  updateEncryptedCloudCvDocumentData,
} from "@/lib/cv/cloud-storage";
import { summarizeLocalDocument } from "@/lib/cv/cv-utils";
import { decryptCvData, encryptCvData } from "@/lib/cv/encryption";
import type { CvData } from "@/lib/cv/schema";
import {
  loadCvDocument,
  removeCvDocument,
  renameCvDocument,
  type CvDocumentSummary,
  type CvStorageKind,
  updateLocalCvDocumentData,
} from "@/lib/cv/storage";

export class MissingPassphraseError extends Error {
  constructor(public readonly documentId: string) {
    super("Enter the encryption password to unlock this CV.");
    this.name = "MissingPassphraseError";
  }
}

export class TermsNotAcceptedError extends Error {
  constructor() {
    super("Accept the current terms before using cloud storage.");
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
  summary: CvDocumentSummary;
};

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

export function createCvStorageAdapters({
  getEncryptionPassphrase,
  requireCloudAccess,
}: {
  getEncryptionPassphrase: (id: string) => string | null;
  requireCloudAccess: (action: string) => Promise<SupabaseClient>;
}): CvStorageAdapters {
  function requirePassphrase(id: string, override?: string) {
    const passphrase = override ?? getEncryptionPassphrase(id);
    if (!passphrase) {
      throw new MissingPassphraseError(id);
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
          throw new Error("The selected local CV could not be loaded.");
        }

        return {
          data: document.data,
          summary: summarizeLocalDocument(document),
        };
      },
      async rename(summary, title) {
        const updatedDocuments = renameCvDocument(summary.id, title);
        const updated = updatedDocuments.find((document) => document.id === summary.id);
        if (!updated) {
          throw new Error("The selected CV could not be renamed.");
        }

        return updated;
      },
      async save(summary, data) {
        const updated = updateLocalCvDocumentData(summary.id, data);
        if (!updated) {
          throw new Error("The active CV could not be saved.");
        }

        return summarizeLocalDocument(updated);
      },
    },
    cloud: {
      async delete(summary) {
        const client = await requireCloudAccess("deleting this cloud CV");
        await deleteCloudCvDocument(client, summary.id);
      },
      async load(summary) {
        const client = await requireCloudAccess("opening this cloud CV");
        const document = await loadCloudCvDocument(client, summary.id);
        return {
          data: document.data,
          summary: document,
        };
      },
      async rename(summary, title) {
        const client = await requireCloudAccess("renaming this cloud CV");
        return renameCloudCvDocument(client, summary.id, title);
      },
      async save(summary, data) {
        const client = await requireCloudAccess("saving this cloud CV");
        return updateCloudCvDocumentData(client, summary.id, data);
      },
    },
    encrypted: {
      async delete(summary) {
        const client = await requireCloudAccess("deleting this cloud CV");
        await deleteCloudCvDocument(client, summary.id);
      },
      async load(summary, options) {
        const client = await requireCloudAccess("opening this encrypted CV");
        const passphrase = requirePassphrase(summary.id, options?.passphraseOverride);
        const document = await loadEncryptedCloudCvDocument(client, summary.id);
        return {
          data: await decryptCvData(document.encryptedPayload, passphrase),
          summary: document,
        };
      },
      async rename(summary, title) {
        const client = await requireCloudAccess("renaming this cloud CV");
        return renameCloudCvDocument(client, summary.id, title);
      },
      async save(summary, data) {
        const client = await requireCloudAccess("saving this encrypted CV");
        const passphrase = requirePassphrase(summary.id);
        const encryptedPayload = await encryptCvData(data, passphrase);
        return updateEncryptedCloudCvDocumentData(client, summary.id, {
          encryptedPayload,
          schemaVersion: data.schemaVersion,
        });
      },
    },
  };
}
