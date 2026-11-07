import { useLayoutEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCloudCvDocument, createEncryptedCloudCvDocument, deleteCloudCvDocument, encryptExistingCloudCvDocument, renameCloudCvDocument, updateCloudCvDocumentData, updateEncryptedCloudCvDocumentData, type CloudCvDocument, type CloudCvWriteToken, type EncryptedCloudCvDocument } from "@/lib/cv/cloud-storage";
import type { EncryptedPayload } from "@/lib/cv/encryption";
import type { CvData } from "@/lib/cv/schema";
import type { CvDocumentSummary } from "@/lib/cv/storage";
import { defaultLocale, type Locale } from "@/i18n/routing";
import { cvCloudDocumentListQueryKey } from "@/components/cv-builder/hooks/use-cv-cloud-document-list-query";
import { cvCloudDocumentQueryKey } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";
type CloudMutationContext = {
  client: SupabaseClient;
  expectedUserId: string;
};
type ExistingCloudMutationContext = CloudMutationContext & { writeToken: CloudCvWriteToken };
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
  const ownerRef = useRef({ userId });
  useLayoutEffect(() => {
    if (ownerRef.current.userId !== userId) ownerRef.current = { userId };
  }, [userId]);
  function captureActor(variables: CloudMutationContext) {
    const actor = ownerRef.current;
    if (!variables.expectedUserId || variables.expectedUserId !== actor.userId) throw new Error("CONFLICT: ACCOUNT_CHANGED");
    return actor;
  }
  function ownsMutation(variables: CloudMutationContext, actor: ReturnType<typeof captureActor> | undefined) {
    return variables.expectedUserId === ownerRef.current.userId && actor === ownerRef.current;
  }
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
    onMutate: captureActor,
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
    onSuccess: (document, variables, actor) => {
      if (!ownsMutation(variables, actor)) return;
      upsertCloudSummary(document);
      setPlainCloudDocument(document);
    }
  });
  const createEncryptedCloudDocument = useMutation({
    onMutate: captureActor,
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
    onSuccess: (document, variables, actor) => {
      if (!ownsMutation(variables, actor)) return;
      upsertCloudSummary(document);
    }
  });
  const encryptExistingCloudDocument = useMutation({
    onMutate: captureActor,
    mutationFn: ({
      client,
      encryptedPayload,
      id,
      schemaVersion,
      expectedUserId,
      writeToken
    }: ExistingCloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      id: string;
      schemaVersion: number;
    }) => encryptExistingCloudCvDocument(client, id, {
      encryptedPayload,
      schemaVersion,
      expectedUserId,
      writeToken
    }, locale),
    onSuccess: (document: EncryptedCloudCvDocument, variables, actor) => {
      if (!ownsMutation(variables, actor)) return;
      upsertCloudSummary(document);
      removePlainCloudDocument(document.id);
    }
  });
  const updateCloudDocumentData = useMutation({
    onMutate: captureActor,
    mutationFn: ({
      client,
      data,
      id,
      expectedUserId,
      writeToken
    }: ExistingCloudMutationContext & {
      data: CvData;
      id: string;
    }) => updateCloudCvDocumentData(client, id, data, expectedUserId, writeToken, locale),
    onSuccess: (document, variables, actor) => {
      if (!ownsMutation(variables, actor)) return;
      upsertCloudSummary(document);
      setPlainCloudDocument(document);
    }
  });
  const updateEncryptedCloudDocumentData = useMutation({
    onMutate: captureActor,
    mutationFn: ({
      client,
      encryptedPayload,
      id,
      schemaVersion,
      expectedUserId,
      writeToken
    }: ExistingCloudMutationContext & {
      encryptedPayload: EncryptedPayload;
      id: string;
      schemaVersion: number;
    }) => updateEncryptedCloudCvDocumentData(client, id, {
      encryptedPayload,
      schemaVersion,
      expectedUserId,
      writeToken
    }, locale),
    onSuccess: (document, variables, actor) => {
      if (!ownsMutation(variables, actor)) return;
      upsertCloudSummary(document);
    }
  });
  const renameCloudDocument = useMutation({
    onMutate: captureActor,
    mutationFn: ({
      client,
      id,
      title,
      expectedUserId,
      writeToken
    }: ExistingCloudMutationContext & {
      id: string;
      title: string;
    }) => renameCloudCvDocument(client, id, title, expectedUserId, writeToken),
    onSuccess: (summary, variables, actor) => {
      if (!ownsMutation(variables, actor)) return;
      upsertCloudSummary(summary);
    }
  });
  const deleteCloudDocument = useMutation({
    onMutate: captureActor,
    mutationFn: async ({
      client,
      id,
      expectedUserId,
      writeToken
    }: ExistingCloudMutationContext & {
      id: string;
    }) => {
      await deleteCloudCvDocument(client, id, expectedUserId, writeToken);
      return id;
    },
    onSuccess: (id, variables, actor) => {
      if (!ownsMutation(variables, actor)) return;
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
