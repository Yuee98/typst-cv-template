import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createCloudCvDocument,
  createEncryptedCloudCvDocument,
  deleteCloudCvDocument,
  encryptExistingCloudCvDocument,
  renameCloudCvDocument,
  updateCloudCvDocumentData,
  updateEncryptedCloudCvDocumentData,
  type CloudCvDocument,
  type EncryptedCloudCvDocument,
} from "@/lib/cv/cloud-storage";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { cvCloudDocumentListQueryKey } from "@/components/cv-builder/hooks/use-cv-cloud-document-list-query";
import { cvCloudDocumentQueryKey } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";

type CloudMutationContext = {
  client: SupabaseClient;
};

function upsertSummary(documents: CvDocumentSummary[], summary: CvDocumentSummary) {
  return documents.some((document) => document.id === summary.id)
    ? documents.map((document) => (document.id === summary.id ? summary : document))
    : [summary, ...documents];
}

export function useCvCloudMutations({ userId }: { userId: string | undefined }) {
  const queryClient = useQueryClient();

  function setCloudDocuments(updater: (current: CvDocumentSummary[]) => CvDocumentSummary[]) {
    if (!userId) {
      return;
    }

    queryClient.setQueryData<CvDocumentSummary[]>(
      cvCloudDocumentListQueryKey(userId),
      (current) => updater(current ?? []),
    );
  }

  function upsertCloudSummary(summary: CvDocumentSummary) {
    setCloudDocuments((current) => upsertSummary(current, summary));
  }

  function setPlainCloudDocument(document: CloudCvDocument) {
    if (!userId) {
      return;
    }

    queryClient.setQueryData(cvCloudDocumentQueryKey(userId, document.id), document);
  }

  function removePlainCloudDocument(id: string) {
    if (!userId) {
      return;
    }

    queryClient.removeQueries({ queryKey: cvCloudDocumentQueryKey(userId, id) });
  }

  const createCloudDocument = useMutation({
    mutationFn: ({ client, data, title }: CloudMutationContext & { data: CvData; title: string }) =>
      createCloudCvDocument(client, { data, title }),
    onSuccess: (document) => {
      upsertCloudSummary(document);
      setPlainCloudDocument(document);
    },
  });

  const createEncryptedCloudDocument = useMutation({
    mutationFn: ({
      client,
      encryptedPayload,
      schemaVersion,
      title,
    }: CloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      schemaVersion: number;
      title: string;
    }) => createEncryptedCloudCvDocument(client, { encryptedPayload, schemaVersion, title }),
    onSuccess: (document) => {
      upsertCloudSummary(document);
    },
  });

  const encryptExistingCloudDocument = useMutation({
    mutationFn: ({
      client,
      encryptedPayload,
      id,
      schemaVersion,
    }: CloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      id: string;
      schemaVersion: number;
    }) => encryptExistingCloudCvDocument(client, id, { encryptedPayload, schemaVersion }),
    onSuccess: (document: EncryptedCloudCvDocument) => {
      upsertCloudSummary(document);
      removePlainCloudDocument(document.id);
    },
  });

  const updateCloudDocumentData = useMutation({
    mutationFn: ({ client, data, id }: CloudMutationContext & { data: CvData; id: string }) =>
      updateCloudCvDocumentData(client, id, data),
    onSuccess: (document) => {
      upsertCloudSummary(document);
      setPlainCloudDocument(document);
    },
  });

  const updateEncryptedCloudDocumentData = useMutation({
    mutationFn: ({
      client,
      encryptedPayload,
      id,
      schemaVersion,
    }: CloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      id: string;
      schemaVersion: number;
    }) => updateEncryptedCloudCvDocumentData(client, id, { encryptedPayload, schemaVersion }),
    onSuccess: (document) => {
      upsertCloudSummary(document);
    },
  });

  const renameCloudDocument = useMutation({
    mutationFn: ({ client, id, title }: CloudMutationContext & { id: string; title: string }) =>
      renameCloudCvDocument(client, id, title),
    onSuccess: (summary) => {
      upsertCloudSummary(summary);
    },
  });

  const deleteCloudDocument = useMutation({
    mutationFn: async ({ client, id }: CloudMutationContext & { id: string }) => {
      await deleteCloudCvDocument(client, id);
      return id;
    },
    onSuccess: (id) => {
      setCloudDocuments((current) => current.filter((document) => document.id !== id));
      removePlainCloudDocument(id);
    },
  });

  return {
    createCloudDocument,
    createEncryptedCloudDocument,
    deleteCloudDocument,
    encryptExistingCloudDocument,
    renameCloudDocument,
    updateCloudDocumentData,
    updateEncryptedCloudDocumentData,
  };
}
