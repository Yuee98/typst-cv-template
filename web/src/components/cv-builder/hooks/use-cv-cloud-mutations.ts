import { useLayoutEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCloudCvDocument, createEncryptedCloudCvDocument, deleteCloudCvDocument, encryptExistingCloudCvDocument, renameCloudCvDocument, updateCloudCvDocumentData, updateEncryptedCloudCvDocumentData, type CloudCvDocument, type EncryptedCloudCvDocument } from "@/lib/cv/cloud-storage";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { cvCloudDocumentListQueryKey } from "@/components/cv-builder/hooks/use-cv-cloud-document-list-query";
import { cvCloudDocumentQueryKey } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";
type CloudMutationContext = {
  client: SupabaseClient;
  expectedUserId?: string;
};
function upsertSummary(documents: CvDocumentSummary[], summary: CvDocumentSummary) {
  return documents.some(document => document.id === summary.id) ? documents.map(document => document.id === summary.id ? summary : document) : [summary, ...documents];
}
export function useCvCloudMutations({
  userId,
  locale = defaultLocale
}: {
  userId: string | undefined;
  locale?: Locale;
}) {
  const queryClient = useQueryClient();
  const ownerRef = useRef(userId);
  useLayoutEffect(() => {
    ownerRef.current = userId;
  }, [userId]);
  function setCloudDocuments(updater: (current: CvDocumentSummary[]) => CvDocumentSummary[]) {
    if (!userId) {
      return;
    }
    queryClient.setQueryData<CvDocumentSummary[]>(cvCloudDocumentListQueryKey(userId), current => updater(current ?? []));
  }
  function upsertCloudSummary(summary: CvDocumentSummary) {
    setCloudDocuments(current => upsertSummary(current, summary));
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
    queryClient.removeQueries({
      queryKey: cvCloudDocumentQueryKey(userId, id)
    });
  }
  const createCloudDocument = useMutation({
    mutationFn: ({
      client,
      data,
      title,
      sourceDocumentId,
      expectedUserId
    }: CloudMutationContext & {
      data: CvData;
      title: string;
      sourceDocumentId?: string;
    }) => createCloudCvDocument(client, {
      data,
      title,
      sourceDocumentId,
      expectedUserId
    }, locale),
    onSuccess: (document, variables) => {
      if (variables.expectedUserId && variables.expectedUserId !== ownerRef.current) return;
      upsertCloudSummary(document);
      setPlainCloudDocument(document);
    }
  });
  const createEncryptedCloudDocument = useMutation({
    mutationFn: ({
      client,
      encryptedPayload,
      schemaVersion,
      title,
      sourceDocumentId,
      expectedUserId
    }: CloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      schemaVersion: number;
      title: string;
      sourceDocumentId?: string;
    }) => createEncryptedCloudCvDocument(client, {
      encryptedPayload,
      schemaVersion,
      title,
      sourceDocumentId,
      expectedUserId
    }, locale),
    onSuccess: (document, variables) => {
      if (variables.expectedUserId && variables.expectedUserId !== ownerRef.current) return;
      upsertCloudSummary(document);
    }
  });
  const encryptExistingCloudDocument = useMutation({
    mutationFn: ({
      client,
      encryptedPayload,
      id,
      schemaVersion
    }: CloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      id: string;
      schemaVersion: number;
    }) => encryptExistingCloudCvDocument(client, id, {
      encryptedPayload,
      schemaVersion
    }, locale),
    onSuccess: (document: EncryptedCloudCvDocument, variables) => {
      if (variables.expectedUserId && variables.expectedUserId !== ownerRef.current) return;
      upsertCloudSummary(document);
      removePlainCloudDocument(document.id);
    }
  });
  const updateCloudDocumentData = useMutation({
    mutationFn: ({
      client,
      data,
      id
    }: CloudMutationContext & {
      data: CvData;
      id: string;
    }) => updateCloudCvDocumentData(client, id, data, locale),
    onSuccess: (document, variables) => {
      if (variables.expectedUserId && variables.expectedUserId !== ownerRef.current) return;
      upsertCloudSummary(document);
      setPlainCloudDocument(document);
    }
  });
  const updateEncryptedCloudDocumentData = useMutation({
    mutationFn: ({
      client,
      encryptedPayload,
      id,
      schemaVersion
    }: CloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      id: string;
      schemaVersion: number;
    }) => updateEncryptedCloudCvDocumentData(client, id, {
      encryptedPayload,
      schemaVersion
    }, locale),
    onSuccess: (document, variables) => {
      if (variables.expectedUserId && variables.expectedUserId !== ownerRef.current) return;
      upsertCloudSummary(document);
    }
  });
  const renameCloudDocument = useMutation({
    mutationFn: ({
      client,
      id,
      title
    }: CloudMutationContext & {
      id: string;
      title: string;
    }) => renameCloudCvDocument(client, id, title),
    onSuccess: (summary, variables) => {
      if (variables.expectedUserId && variables.expectedUserId !== ownerRef.current) return;
      upsertCloudSummary(summary);
    }
  });
  const deleteCloudDocument = useMutation({
    mutationFn: async ({
      client,
      id
    }: CloudMutationContext & {
      id: string;
    }) => {
      await deleteCloudCvDocument(client, id);
      return id;
    },
    onSuccess: (id, variables) => {
      if (variables.expectedUserId && variables.expectedUserId !== ownerRef.current) return;
      setCloudDocuments(current => current.filter(document => document.id !== id));
      removePlainCloudDocument(id);
    }
  });
  return {
    createCloudDocument,
    createEncryptedCloudDocument,
    deleteCloudDocument,
    encryptExistingCloudDocument,
    renameCloudDocument,
    updateCloudDocumentData,
    updateEncryptedCloudDocumentData
  };
}
