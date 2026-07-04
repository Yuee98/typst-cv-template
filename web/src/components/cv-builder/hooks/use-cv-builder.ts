import { zodResolver } from "@hookform/resolvers/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { useAuthModal } from "@/components/cv-builder/hooks/use-auth-modal";
import { useCloudSession } from "@/components/cv-builder/hooks/use-cloud-session";
import { useCvDocuments } from "@/components/cv-builder/hooks/use-cv-documents";
import { useCvExport } from "@/components/cv-builder/hooks/use-cv-export";
import { useCvPersistence } from "@/components/cv-builder/hooks/use-cv-persistence";
import { useCvPreview } from "@/components/cv-builder/hooks/use-cv-preview";
import { useEncryptionModal, type EncryptionSubmitPayload } from "@/components/cv-builder/hooks/use-encryption-modal";
import { useTermsGate } from "@/components/cv-builder/hooks/use-terms-gate";
import {
  createCloudCvDocument,
  createEncryptedCloudCvDocument,
  encryptExistingCloudCvDocument,
  listCloudCvDocuments,
  loadCloudCvDocument,
  loadEncryptedCloudCvDocument,
} from "@/lib/cv/cloud-storage";
import {
  cloneCvData,
  createEmptyCvData,
  errorMessage,
  summarizeLocalDocument,
  titleFromImportedData,
} from "@/lib/cv/cv-utils";
import { clearCvDraft, loadCvDraft, saveCvDraft } from "@/lib/cv/draft-storage";
import { decryptCvData, encryptCvData } from "@/lib/cv/encryption";
import {
  clearEncryptionPasswords,
  loadEncryptionPassword,
  loadTrustDevice,
  storeEncryptionPassword,
  storeTrustDevice,
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
  removeCvDocument,
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
      await refreshCloudDocuments(client, { skipTermsCheck: true });
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

  // ── cloud sync ───────────────────────────────────────────────────

  async function refreshCloudDocuments(
    client: SupabaseClient | null = supabase,
    { skipTermsCheck = false }: { skipTermsCheck?: boolean } = {},
  ) {
    if (!client) {
      return;
    }

    if (!skipTermsCheck && !(await termsGate.ensure(client))) {
      setCloudStatus("idle");
      return;
    }

    setCloudStatus("loading");

    try {
      const cloudDocuments = await listCloudCvDocuments(client);
      replaceCloudSummaries(cloudDocuments);

      const currentActiveId = activeDocumentIdRef.current;
      const activeIsCloud = cloudDocuments.some((d) => d.id === currentActiveId && d.storageKind === "cloud");
      const activeIsEncrypted = cloudDocuments.some((d) => d.id === currentActiveId && d.storageKind === "encrypted");

      if (activeIsCloud && currentActiveId) {
        const document = await loadCloudCvDocument(client, currentActiveId);
        upsertDocumentSummary(document);
        const draft = loadDraft(currentActiveId);
        loadDataIntoForm(document.id, draft ?? document.data);
        if (draft) {
          setIsDirty(true);
        }
      } else if (activeIsEncrypted && currentActiveId) {
        // Encrypted CV needs password to load — don't auto-load here
        // User will click to unlock via selectDocument
      } else if (!currentActiveId && cloudDocuments[0]?.storageKind === "cloud") {
        const document = await loadCloudCvDocument(client, cloudDocuments[0].id);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, document.data);
      }

      setCloudStatus("ready");
    } catch (cloudError) {
      setCloudStatus("error");
      setLibraryError(errorMessage(cloudError));
    }
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

  useEffect(() => {
    if (!sessionInitialized || !supabase) {
      return;
    }

    const client = supabase;
    let cancelled = false;

    if (!session) {
      removeCloudSummaries();
      termsGate.reset();
      authModal.setTermsAccepted(false);
      setCloudStatus("idle");
      return;
    }

    encryptionModal.setTrustDevice(loadTrustDevice(session.user.id));
    void (async () => {
      const accepted = await termsGate.refresh(client);
      if (cancelled) {
        return;
      }

      if (accepted) {
        await refreshCloudDocuments(client, { skipTermsCheck: true });
      } else {
        removeCloudSummaries();
        setCloudStatus("idle");
      }
    })();

    return () => {
      cancelled = true;
    };
    // refreshCloudDocuments is intentionally not a dependency; this reacts only to auth session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionInitialized, session, supabase]);

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

  // ── document CRUD ────────────────────────────────────────────────

  async function selectDocument(id: string) {
    if (id === activeDocumentId) {
      return;
    }

    // Auto-save only for local CVs when switching away
    if (activeDocumentId && activeDocument?.storageKind === "local") {
      if (!(await persistence.saveCurrentDocument({ silent: true }))) {
        return;
      }
    }

    const documentSummary = documents.find((document) => document.id === id);
    if (!documentSummary) {
      setLibraryError("The selected CV could not be loaded.");
      return;
    }

    try {
      const document = await storageAdapters[documentSummary.storageKind].load(documentSummary);
      upsertDocumentSummary(document.summary);

      const draft = documentSummary.storageKind === "cloud" ? loadDraft(id) : null;
      loadDataIntoForm(document.summary.id, draft ?? document.data);
      if (draft) {
        setIsDirty(true);
      }
    } catch (loadError) {
      if (handleStorageDeferredError(loadError, "unlock")) {
        return;
      }

      setLibraryError(errorMessage(loadError));
    }
  }

  async function createDocumentFromData(data: CvData, title: string) {
    if (activeDocumentId) {
      await persistence.saveCurrentDocument({ silent: true });
    }

    const document = createLocalCvDocument(data, title);
    replaceLocalDocumentSummary(document);
    loadDataIntoForm(document.id, document.data);
  }

  async function createSampleDocument() {
    await createDocumentFromData(cloneCvData(sampleCvData), "Sample CV");
  }

  async function createEmptyDocument() {
    await createDocumentFromData(createEmptyCvData(), "Untitled CV");
  }

  async function renameDocument(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    const nextTitle = window.prompt("Rename CV", current.title);
    if (!nextTitle) {
      return;
    }

    try {
      const updated = await storageAdapters[current.storageKind].rename(current, nextTitle);
      upsertDocumentSummary(updated);
    } catch (renameError) {
      if (handleStorageDeferredError(renameError, "unlock")) {
        return;
      }

      setLibraryError(errorMessage(renameError));
    }
  }

  async function duplicateDocument(id: string, passphraseOverride?: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    try {
      const source = await storageAdapters[current.storageKind].load(current, { passphraseOverride });
      const document = createLocalCvDocument(source.data, `${source.summary.title} Copy`);
      replaceLocalDocumentSummary(document);
      loadDataIntoForm(document.id, document.data);
    } catch (duplicateError) {
      if (handleStorageDeferredError(duplicateError, "duplicate")) {
        return;
      }

      setLibraryError(errorMessage(duplicateError));
    }
  }

  async function deleteDocument(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    if (!window.confirm(`Delete "${current.title}"?`)) {
      return;
    }

    try {
      await storageAdapters[current.storageKind].delete(current);

      const nextDocuments = documents.filter((document) => document.id !== id);
      setOrderedDocuments(nextDocuments);

      if (id === activeDocumentId) {
        setActiveDocumentId(null);
        saveActiveCvDocumentId(null);
        form.reset(createEmptyCvData());
        preview.reset();
        setLibraryError(null);
        setIsDirty(false);
      }
    } catch (deleteError) {
      if (handleStorageDeferredError(deleteError, "unlock")) {
        return;
      }

      setLibraryError(errorMessage(deleteError));
    }
  }

  // ── cloud operations ─────────────────────────────────────────────

  async function moveToCloud(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    if (!supabase || !session) {
      setLibraryError("Sign in before moving a CV to cloud storage.");
      return;
    }

    if (!(await termsGate.ensure())) {
      return;
    }

    if (current.storageKind !== "local") {
      return;
    }

    try {
      if (id === activeDocumentId) {
        await persistence.saveCurrentDocument({ silent: true });
      }

      const localDocument = loadCvDocument(id);
      if (!localDocument) {
        throw new Error("The selected local CV could not be loaded.");
      }

      const cloudDocument = await createCloudCvDocument(supabase, {
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
      setLibraryError(errorMessage(moveError));
    }
  }

  async function enableEncryption(id: string, password: string, trustDevice: boolean) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    if (!supabase || !session) {
      setLibraryError("Sign in before enabling encrypted cloud storage.");
      return;
    }

    if (!(await termsGate.ensure())) {
      return;
    }

    if (!password) {
      setLibraryError("Enter an encryption password before enabling encryption.");
      return;
    }

    if (current.storageKind === "encrypted") {
      return;
    }

    try {
      if (id === activeDocumentId) {
        await persistence.saveCurrentDocument({ silent: true });
      }

      const sourceData =
        current.storageKind === "local"
          ? loadCvDocument(id)?.data
          : (await loadCloudCvDocument(supabase, id)).data;

      if (!sourceData) {
        throw new Error("The selected CV could not be loaded before encryption.");
      }

      const encryptedPayload = await encryptCvData(sourceData, password);

      if (current.storageKind === "local") {
        const encryptedDocument = await createEncryptedCloudCvDocument(supabase, {
          title: current.title,
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion,
        });
        removeCvDocument(id);
        if (session?.user.id) {
          storeEncryptionPassword(session.user.id, encryptedDocument.id, password, trustDevice);
        }
        setOrderedDocuments((currentDocuments) => [
          encryptedDocument,
          ...currentDocuments.filter((document) => document.id !== id),
        ]);
        loadDataIntoForm(encryptedDocument.id, sourceData);
      } else {
        const encryptedDocument = await encryptExistingCloudCvDocument(supabase, id, {
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion,
        });
        upsertDocumentSummary(encryptedDocument);
        loadDataIntoForm(id, sourceData);
      }

      setCloudStatus("ready");
    } catch (encryptionError) {
      setLibraryError(errorMessage(encryptionError));
    }
  }

  // ── encryption modal ─────────────────────────────────────────────

  async function unlockEncryptedDocument(id: string, password: string) {
    if (!supabase || !session) {
      throw new Error("Sign in before opening this encrypted CV.");
    }

    if (!(await termsGate.ensure())) {
      return;
    }

    const document = await loadEncryptedCloudCvDocument(supabase, id);
    const decryptedData = await decryptCvData(document.encryptedPayload, password);
    upsertDocumentSummary(document);
    loadDataIntoForm(document.id, decryptedData);
  }

  async function openEnableEncryptionModal(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current || current.storageKind === "encrypted") {
      return;
    }

    if (!supabase || !session) {
      setLibraryError("Sign in before enabling encrypted cloud storage.");
      return;
    }

    if (!(await termsGate.ensure())) {
      return;
    }

    encryptionModal.openModal("enable", id);
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

      encryptionModal.closeModal();
    } catch (modalError) {
      return { error: errorMessage(modalError) };
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

      const document = createLocalCvDocument(parsed.data, titleFromImportedData(parsed.data));
      replaceLocalDocumentSummary(document);
      loadDataIntoForm(document.id, document.data);
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
    selectDocument,
    createSampleDocument,
    createEmptyDocument,
    renameDocument,
    duplicateDocument,
    deleteDocument,
    reorderDocuments,
    toggleLibraryCollapsed,
    moveToCloud,
    openEnableEncryptionModal,
    refreshCloudDocuments,
    handleEncryptionSubmit,
    importJson,
    downloadPdf: cvExport.downloadPdf,
    exportTypstPackage: cvExport.exportTypstPackage,
    exportTypstSource: cvExport.exportTypstSource,
    exportDocument: cvExport.exportDocument,
  };
}
