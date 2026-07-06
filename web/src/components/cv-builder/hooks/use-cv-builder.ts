import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { useAuthModal } from "@/components/cv-builder/hooks/use-auth-modal";
import { useCloudSession } from "@/components/cv-builder/hooks/use-cloud-session";
import { useCvAuthActions } from "@/components/cv-builder/hooks/use-cv-auth-actions";
import { useCvCloudDocumentActions } from "@/components/cv-builder/hooks/use-cv-cloud-document-actions";
import { useCvCloudDocumentListQuery } from "@/components/cv-builder/hooks/use-cv-cloud-document-list-query";
import { useCvCloudDocumentQuery } from "@/components/cv-builder/hooks/use-cv-cloud-document-query";
import { useCvCloudMutations } from "@/components/cv-builder/hooks/use-cv-cloud-mutations";
import { useCvCloudSync } from "@/components/cv-builder/hooks/use-cv-cloud-sync";
import { useCvDocumentActions } from "@/components/cv-builder/hooks/use-cv-document-actions";
import { useCvDocuments } from "@/components/cv-builder/hooks/use-cv-documents";
import { useCvExport } from "@/components/cv-builder/hooks/use-cv-export";
import { useCvLibraryBootstrap } from "@/components/cv-builder/hooks/use-cv-library-bootstrap";
import { useCvPersistence } from "@/components/cv-builder/hooks/use-cv-persistence";
import { useCvPreview } from "@/components/cv-builder/hooks/use-cv-preview";
import { useEncryptionModal } from "@/components/cv-builder/hooks/use-encryption-modal";
import { useTermsGate } from "@/components/cv-builder/hooks/use-terms-gate";
import type { Locale } from "@/i18n/routing";
import {
  cloneCvData,
  errorMessage,
  titleFromImportedData,
} from "@/lib/cv/cv-utils";
import { clearCvDraft, loadCvDraft, saveCvDraft } from "@/lib/cv/draft-storage";
import { loadEncryptionPassword } from "@/lib/cv/encryption-storage";
import { cvSchema, persistedCvSchema, type CvData } from "@/lib/cv/schema";
import { getSampleCvData } from "@/lib/cv/sample-data";
import {
  type CvCloudAccessAction,
  createCvStorageAdapters,
  isMissingPassphraseError,
  isTermsNotAcceptedError,
  TermsNotAcceptedError,
} from "@/lib/cv/storage-adapters";
import { saveActiveCvDocumentId } from "@/lib/cv/storage";

export function useCvBuilder() {
  const locale = useLocale() as Locale;
  const tActions = useTranslations("CvDocumentActions");
  const tImportExport = useTranslations("ImportExport");
  const tCloudActions = useTranslations("CvCloudActions");
  const tPersistence = useTranslations("CvPersistence");
  const tTermsGate = useTranslations("TermsGate");
  const tEncryption = useTranslations("EncryptionModal");
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [importExportError, setImportExportError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const {
    activeDocument,
    activeDocumentId,
    documents,
    libraryCollapsed,
    loadCollapsedPreference,
    removeCloudSummaries,
    reorderDocuments,
    replaceCloudSummaries,
    replaceLocalDocumentSummary,
    setActiveDocumentId,
    setOrderedDocuments,
    toggleLibraryCollapsed,
    upsertDocumentSummary,
  } = useCvDocuments({ initializedRef });

  const { cloudStatus, session, sessionInitialized, setCloudStatus, supabase } = useCloudSession({
    onError: setLibraryError,
  });

  const authModal = useAuthModal();

  const termsGate = useTermsGate({
    tTermsGate,
    hasSession: Boolean(session),
    onError: setLibraryError,
    supabase,
  });

  const encryptionModal = useEncryptionModal(tEncryption);
  const [isDirty, setIsDirty] = useState(false);

  const form = useForm<CvData>({
    resolver: zodResolver(cvSchema),
    defaultValues: cloneCvData(getSampleCvData(locale)),
    mode: "onChange",
  });

  const watchedData = useWatch({ control: form.control });
  const supabaseConfigured = Boolean(supabase);
  const cloudActionsEnabled = Boolean(supabase && session);
  const { data: documentsData, refetch: refetchDocuments } = useCvCloudDocumentListQuery({
    enabled: termsGate.status === "accepted",
    session,
    supabase,
  });
  const { fetchCloudDocument } = useCvCloudDocumentQuery({ session });
  const cloudMutations = useCvCloudMutations({ userId: session?.user.id, locale });

  const storageAdapters = createCvStorageAdapters({
    locale,
    cloudStorage: {
      deleteCloudDocument: async (client, id) => {
        await cloudMutations.deleteCloudDocument.mutateAsync({ client, id });
      },
      loadCloudDocument: (client, id) => fetchCloudDocument(client, id, locale),
      renameCloudDocument: (client, id, title) =>
        cloudMutations.renameCloudDocument.mutateAsync({ client, id, title }),
      updateCloudDocumentData: (client, id, data) =>
        cloudMutations.updateCloudDocumentData.mutateAsync({ client, data, id }),
      updateEncryptedCloudDocumentData: (client, id, update) =>
        cloudMutations.updateEncryptedCloudDocumentData.mutateAsync({ client, id, ...update }),
    },
    getEncryptionPassphrase: getKnownEncryptionPassphrase,
    requireCloudAccess,
  });

  const persistence = useCvPersistence({
    tPersistence,
    activeDocument,
    activeDocumentId,
    clearDraft,
    form,
    handleStorageDeferredError,
    loadDataIntoForm,
    onDirtyChange: setIsDirty,
    onError: setLibraryError,
    storageAdapters,
    upsertDocumentSummary,
  });

  const preview = useCvPreview({
    tImportExport,
    locale,
    activeDocument,
    activeDocumentId,
    form,
    initializedRef,
    onDirtyChange: setIsDirty,
    saveCurrentDocument: persistence.saveCurrentDocument,
    saveDraft,
    watchedData,
  });

  const cvExport = useCvExport({
    canExport: () => Boolean(activeDocumentId && activeDocument),
    locale,
    getCurrentData: getCurrentCvData,
    getDownloadTitle: currentDownloadTitle,
    onImportExportError: setImportExportError,
    onPreviewError: preview.setError,
  });

  const documentActions = useCvDocumentActions({
    activeDocument,
    activeDocumentId,
    documents,
    form,
    handleStorageDeferredError,
    loadDataIntoForm,
    loadDraft,
    onDirtyChange: setIsDirty,
    onError: setLibraryError,
    replaceLocalDocumentSummary,
    resetActiveDocument,
    saveCurrentDocument: persistence.saveCurrentDocument,
    setActiveDocumentId,
    setOrderedDocuments,
    storageAdapters,
    upsertDocumentSummary,
  });

  const cloudSync = useCvCloudSync({
    locale,
    activeDocumentId,
    documentsData,
    loadDataIntoForm,
    loadDraft,
    onDirtyChange: setIsDirty,
    onError: setLibraryError,
    refetchDocuments,
    removeCloudSummaries,
    replaceCloudSummaries,
    session,
    sessionInitialized,
    setCloudStatus,
    setTermsAccepted: authModal.setTermsAccepted,
    setTrustDevice: encryptionModal.setTrustDevice,
    supabase,
    termsGate,
    upsertDocumentSummary,
  });

  const cloudDocumentActions = useCvCloudDocumentActions({
    locale,
    tCloudActions,
    activeDocumentId,
    closeEncryptionModal: encryptionModal.closeModal,
    createCloudDocument: cloudMutations.createCloudDocument.mutateAsync,
    createEncryptedCloudDocument: cloudMutations.createEncryptedCloudDocument.mutateAsync,
    documents,
    duplicateDocument: documentActions.duplicateDocument,
    encryptExistingCloudDocument: cloudMutations.encryptExistingCloudDocument.mutateAsync,
    fetchCloudDocument: fetchCloudDocument,
    loadDataIntoForm,
    onError: setLibraryError,
    openEnableEncryptionModal: (documentId) => encryptionModal.openModal("enable", documentId),
    saveCurrentDocument: persistence.saveCurrentDocument,
    session,
    setCloudStatus,
    setOrderedDocuments,
    supabase,
    termsGate,
    upsertDocumentSummary,
  });
  
  const authActions = useCvAuthActions({
    activeDocument,
    authModal,
    closeEncryptionModal: encryptionModal.closeModal,
    documents,
    form,
    loadDataIntoForm,
    session,
    setOrderedDocuments,
    supabase,
    termsGate,
  });
  useCvLibraryBootstrap({
    form,
    initialData: cloneCvData(getSampleCvData(locale)),
    initializedRef,
    loadCollapsedPreference,
    localFallbackTitle: tActions("localTitle"),
    setActiveDocumentId,
    setOrderedDocuments,
  });

  // ── helpers ──────────────────────────────────────────────────────

  function getKnownEncryptionPassphrase(id: string) {
    const userId = session?.user.id;
    return userId ? loadEncryptionPassword(userId, id) : null;
  }

  async function requireCloudAccess(action: CvCloudAccessAction) {
    if (!supabase || !session) {
      throw new Error(tCloudActions(action));
    }

    if (!(await termsGate.ensure())) {
      throw new TermsNotAcceptedError(locale);
    }

    return supabase;
  }

  function handleStorageDeferredError(error: unknown, mode: "unlock" | "duplicate") {
    if (isTermsNotAcceptedError(error)) {
      return true;
    }

    if (isMissingPassphraseError(error)) {
      encryptionModal.openModal(mode, error.documentId);
      return true;
    }

    return false;
  }

  function loadDataIntoForm(id: string, data: CvData) {
    setActiveDocumentId(id);
    saveActiveCvDocumentId(id);
    form.reset(data);
    preview.resetForFormLoad();
    setLibraryError(null);
    setIsDirty(false);
  }

  function saveDraft(cvId: string, data: CvData) {
    saveCvDraft(session?.user.id, cvId, data);
  }

  function loadDraft(cvId: string): CvData | null {
    return loadCvDraft(session?.user.id, cvId);
  }

  function clearDraft(cvId: string) {
    clearCvDraft(session?.user.id, cvId);
  }

  function resetActiveDocument() {
    preview.reset();
    setLibraryError(null);
    setIsDirty(false);
  }

  async function acceptTerms() {
    if (await termsGate.accept()) {
      await cloudSync.refreshCloudDocuments({ skipTermsCheck: true });
    }
  }

  // ── export / import ──────────────────────────────────────────────

  function getCurrentCvData() {
    const parsed = cvSchema.safeParse(form.getValues());
    if (!parsed.success) {
      throw new Error(tImportExport("currentSchemaError"));
    }

    return parsed.data;
  }

  function currentDownloadTitle(data: CvData) {
    return activeDocument?.title || titleFromImportedData(data, tImportExport("importFallbackTitle"));
  }

  async function importJson(file: File | undefined) {
    if (!file) {
      return;
    }

    try {
      const parsed = persistedCvSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        setImportExportError(tImportExport("importSchemaError"));
        return;
      }

      await documentActions.createDocumentFromData(parsed.data, titleFromImportedData(parsed.data, tImportExport("importFallbackTitle")));
    } catch (importError) {
      setImportExportError(errorMessage(importError));
    }
  }

  // ── return ───────────────────────────────────────────────────────

  return {
    // state
    svg: preview.svg,
    status: preview.status,
    percent: preview.percent,
    previewError: preview.error,
    libraryError,
    importExportError,
    documents,
    activeDocumentId,
    activeDocument,
    isDirty,
    saving: persistence.saving,
    exportingFormat: cvExport.exportingFormat,
    libraryCollapsed,
    session,
    cloudStatus,
    supabaseConfigured,
    cloudActionsEnabled,
    authModal,
    termsGate,
    encryptionModal,
    form,

    // setters
    setLibraryError,
    setImportExportError,

    // actions
    signIn: authActions.signIn,
    signUp: authActions.signUp,
    signInWithGithub: authActions.signInWithGithub,
    acceptTerms,
    signOut: authActions.signOut,
    saveCurrentDocument: persistence.saveCurrentDocument,
    discardChanges: persistence.discardChanges,
    selectDocument: documentActions.selectDocument,
    createSampleDocument: documentActions.createSampleDocument,
    createEmptyDocument: documentActions.createEmptyDocument,
    renameDocument: documentActions.renameDocument,
    duplicateDocument: documentActions.duplicateDocument,
    deleteDocument: documentActions.deleteDocument,
    reorderDocuments,
    toggleLibraryCollapsed,
    moveToCloud: cloudDocumentActions.moveToCloud,
    openEnableEncryptionModal: cloudDocumentActions.openEnableEncryption,
    refreshCloudDocuments: cloudSync.refreshCloudDocuments,
    handleEncryptionSubmit: cloudDocumentActions.handleEncryptionSubmit,
    importJson,
    downloadPdf: cvExport.downloadPdf,
    exportTypstPackage: cvExport.exportTypstPackage,
    exportTypstSource: cvExport.exportTypstSource,
    exportDocument: cvExport.exportDocument,
  };
}
