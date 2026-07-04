import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { useAuthModal } from "@/components/cv-builder/hooks/use-auth-modal";
import { useCloudSession } from "@/components/cv-builder/hooks/use-cloud-session";
import { useCvCloudDocumentActions } from "@/components/cv-builder/hooks/use-cv-cloud-document-actions";
import { useCvCloudSync } from "@/components/cv-builder/hooks/use-cv-cloud-sync";
import { useCvDocumentActions } from "@/components/cv-builder/hooks/use-cv-document-actions";
import { useCvDocuments } from "@/components/cv-builder/hooks/use-cv-documents";
import { useCvExport } from "@/components/cv-builder/hooks/use-cv-export";
import { useCvPersistence } from "@/components/cv-builder/hooks/use-cv-persistence";
import { useCvPreview } from "@/components/cv-builder/hooks/use-cv-preview";
import { useEncryptionModal } from "@/components/cv-builder/hooks/use-encryption-modal";
import { useTermsGate } from "@/components/cv-builder/hooks/use-terms-gate";
import {
  cloneCvData,
  errorMessage,
  summarizeLocalDocument,
  titleFromImportedData,
} from "@/lib/cv/cv-utils";
import { clearCvDraft, loadCvDraft, saveCvDraft } from "@/lib/cv/draft-storage";
import {
  clearEncryptionPasswords,
  loadEncryptionPassword,
} from "@/lib/cv/encryption-storage";
import { cvSchema, persistedCvSchema, type CvData } from "@/lib/cv/schema";
import { sampleCvData } from "@/lib/cv/sample-data";
import {
  createCvStorageAdapters,
  isMissingPassphraseError,
  isTermsNotAcceptedError,
  TermsNotAcceptedError,
} from "@/lib/cv/storage-adapters";
import {
  createLocalCvDocument,
  initializeCvDocumentLibrary,
  loadCvDocument,
  saveActiveCvDocumentId,
} from "@/lib/cv/storage";

export function useCvBuilder() {
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [importExportError, setImportExportError] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const {
    activeDocument,
    activeDocumentId,
    activeDocumentIdRef,
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
    hasSession: Boolean(session),
    onAccepted: async (client) => {
      await cloudSync.refreshCloudDocuments(client, { skipTermsCheck: true });
    },
    onError: setLibraryError,
    supabase,
  });
  const encryptionModal = useEncryptionModal();
  const [isDirty, setIsDirty] = useState(false);

  const form = useForm<CvData>({
    resolver: zodResolver(cvSchema),
    defaultValues: cloneCvData(sampleCvData),
    mode: "onChange",
  });

  const watchedData = useWatch({ control: form.control });
  const supabaseConfigured = Boolean(supabase);
  const cloudActionsEnabled = Boolean(supabase && session);
  const storageAdapters = createCvStorageAdapters({
    getEncryptionPassphrase: getKnownEncryptionPassphrase,
    requireCloudAccess,
  });
  const persistence = useCvPersistence({
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
    activeDocumentIdRef,
    loadDataIntoForm,
    loadDraft,
    onDirtyChange: setIsDirty,
    onError: setLibraryError,
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
    activeDocumentId,
    closeEncryptionModal: encryptionModal.closeModal,
    documents,
    duplicateDocument: documentActions.duplicateDocument,
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

  // ── helpers ──────────────────────────────────────────────────────

  function getKnownEncryptionPassphrase(id: string) {
    const userId = session?.user.id;
    return userId ? loadEncryptionPassword(userId, id) : null;
  }

  async function requireCloudAccess(action: string) {
    if (!supabase || !session) {
      throw new Error(`Sign in before ${action}.`);
    }

    if (!(await termsGate.ensure())) {
      throw new TermsNotAcceptedError();
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

  // ── effects ──────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      const library = initializeCvDocumentLibrary(cloneCvData(sampleCvData));
      const activeSummary = library.documents.find((d) => d.id === library.activeDocumentId);
      const isCloudActive = activeSummary?.storageKind === "cloud" || activeSummary?.storageKind === "encrypted";
      const initialDocument = library.activeDocumentId ? loadCvDocument(library.activeDocumentId) : null;

      if (!initialDocument && library.documents.length === 0) {
        setOrderedDocuments([]);
        setActiveDocumentId(null);
        loadCollapsedPreference();
        initializedRef.current = true;
        return;
      }

      // Cloud/encrypted CV: keep the ID, let refreshCloudDocuments load it later
      if (!initialDocument && isCloudActive && library.activeDocumentId) {
        setOrderedDocuments(library.documents);
        setActiveDocumentId(library.activeDocumentId);
        loadCollapsedPreference();
        initializedRef.current = true;
        return;
      }

      const documentToLoad = initialDocument ?? createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
      const nextDocuments = initialDocument
        ? library.documents
        : [summarizeLocalDocument(documentToLoad), ...library.documents];

      setOrderedDocuments(nextDocuments);
      setActiveDocumentId(documentToLoad.id);
      saveActiveCvDocumentId(documentToLoad.id);
      loadCollapsedPreference();
      form.reset(documentToLoad.data);
      initializedRef.current = true;
    });

    return () => {
      cancelled = true;
    };
    // This is a one-time local library bootstrap; helper dependencies would retrigger storage hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // ── auth ─────────────────────────────────────────────────────────

  async function signIn() {
    if (!supabase) {
      authModal.setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authModal.email || !authModal.password) {
      authModal.setError("Enter email and password before signing in.");
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: authModal.email,
      password: authModal.password,
    });

    if (signInError) {
      authModal.setError(signInError.message);
    } else {
      authModal.closeAfterAuth();
    }
  }

  async function signUp() {
    if (!supabase) {
      authModal.setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authModal.email || !authModal.password) {
      authModal.setError("Enter email and password before creating an account.");
      return;
    }

    if (!authModal.termsAccepted) {
      authModal.setError("Agree to the Terms of Use and acknowledge the Privacy Policy before continuing.");
      return;
    }

    termsGate.markPendingAcceptance();

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: authModal.email,
      password: authModal.password,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    if (signUpError) {
      termsGate.clearPendingAcceptance();
      authModal.setError(signUpError.message);
      return;
    }

    if (!data.session) {
      authModal.setError(null);
      authModal.setSuccessMessage("Account created. Check your email before signing in.");
    } else {
      try {
        await termsGate.recordAccepted(supabase);
      } catch (termsError) {
        authModal.setError(errorMessage(termsError));
        return;
      }

      authModal.closeAfterAuth();
    }
  }

  async function signInWithGithub() {
    if (!supabase) {
      authModal.setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (authModal.mode === "signUp") {
      if (!authModal.termsAccepted) {
        authModal.setError("Agree to the Terms of Use and acknowledge the Privacy Policy before continuing.");
        return;
      }

      termsGate.markPendingAcceptance();
    }

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (oauthError) {
      if (authModal.mode === "signUp") {
        termsGate.clearPendingAcceptance();
      }
      authModal.setError(oauthError.message);
    }
  }

  async function signOut() {
    if (!supabase) {
      return;
    }

    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      authModal.setError(signOutError.message);
      return;
    }

    if (session?.user.id) {
      clearEncryptionPasswords(window.sessionStorage, session.user.id);
      clearEncryptionPasswords(window.localStorage, session.user.id);
    }
    encryptionModal.closeModal();

    const localDocuments = documents.filter((document) => document.storageKind === "local");
    const activeIsCloudBacked = activeDocument?.storageKind === "cloud" || activeDocument?.storageKind === "encrypted";
    if (activeIsCloudBacked || localDocuments.length === 0) {
      const parsed = cvSchema.safeParse(form.getValues());
      const fallbackData = parsed.success ? parsed.data : cloneCvData(sampleCvData);
      const fallbackTitle = activeDocument?.title ?? titleFromImportedData(fallbackData);
      const localDocument = createLocalCvDocument(fallbackData, fallbackTitle);
      setOrderedDocuments([summarizeLocalDocument(localDocument), ...localDocuments]);
      loadDataIntoForm(localDocument.id, localDocument.data);
    } else {
      setOrderedDocuments(localDocuments);
    }
  }

  // ── export / import ──────────────────────────────────────────────

  function getCurrentCvData() {
    const parsed = cvSchema.safeParse(form.getValues());
    if (!parsed.success) {
      throw new Error("The current form data does not match the CV schema.");
    }

    return parsed.data;
  }

  function currentDownloadTitle(data: CvData) {
    return activeDocument?.title || titleFromImportedData(data);
  }

  async function importJson(file: File | undefined) {
    if (!file) {
      return;
    }

    try {
      const parsed = persistedCvSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        setImportExportError("Imported JSON does not match a supported CV schema.");
        return;
      }

      await documentActions.createDocumentFromData(parsed.data, titleFromImportedData(parsed.data));
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
    signIn,
    signUp,
    signInWithGithub,
    acceptTerms: termsGate.accept,
    signOut,
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
