import { zodResolver } from "@hookform/resolvers/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import type { LoadStage } from "@/lib/typst/render";
import { useEncryptionModal, type EncryptionSubmitPayload } from "@/components/cv-builder/hooks/use-encryption-modal";
import {
  createCloudCvDocument,
  createEncryptedCloudCvDocument,
  deleteCloudCvDocument,
  encryptExistingCloudCvDocument,
  listCloudCvDocuments,
  loadCloudCvDocument,
  loadEncryptedCloudCvDocument,
  renameCloudCvDocument,
  updateCloudCvDocumentData,
  updateEncryptedCloudCvDocumentData,
} from "@/lib/cv/cloud-storage";
import { TERMS_VERSION } from "@/content/legal";
import {
  cloneCvData,
  createEmptyCvData,
  errorMessage,
  summarizeLocalDocument,
  titleFromImportedData,
} from "@/lib/cv/cv-utils";
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
  createLocalCvDocument,
  initializeCvDocumentLibrary,
  loadCvDocument,
  loadCvLibraryCollapsed,
  removeCvDocument,
  renameCvDocument,
  saveActiveCvDocumentId,
  sortCvDocumentSummariesByStoredOrder,
  storeCvDocumentOrder,
  storeCvLibraryCollapsed,
  type CvDocumentSummary,
  type LocalCvDocument,
  updateLocalCvDocumentData,
} from "@/lib/cv/storage";
import { buildTypstDocument } from "@/lib/cv/typst";
import { acceptCurrentTerms, hasAcceptedCurrentTerms } from "@/lib/legal/terms-acceptance";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadLocalFontData } from "@/lib/typst/font-access";
import { addFontFromData, fetchStyleSource, renderTypstPdf, renderTypstSvg } from "@/lib/typst/render";
import { createZip } from "@/lib/zip";

type CloudStatus = "idle" | "loading" | "ready" | "error";
type AuthModalMode = "signIn" | "signUp";
type TermsStatus = "unknown" | "accepted" | "required";
type ExportFormat = "pdf" | "typst-package" | "typst-source" | "json";

const CUSTOM_FONT_SENTINEL = "__custom__";

function selectedFontFamilies(data: CvData) {
  if (!data.bodyFont || data.bodyFont === CUSTOM_FONT_SENTINEL) return [];

  return data.bodyFont
    .split(",")
    .map((font) => font.trim())
    .filter(Boolean);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toArrayBuffer(data: Uint8Array) {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

function safeDownloadName(title: string, extension: string) {
  const baseName = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${baseName || "resume"}.${extension}`;
}

function buildTypstPackageReadme() {
  return [
    "Typst CV package",
    "",
    "Files:",
    "- resume.typ: generated Typst source",
    "- style.typ: template style used by the web preview",
    "- data.json: structured CV data backup",
    "",
    "Compile locally:",
    "typst compile resume.typ resume.pdf",
    "",
    "If this CV uses custom local fonts, install fonts with matching family names before compiling locally.",
    "",
  ].join("\n");
}

export function useCvBuilder() {
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStage>("idle");
  const [percent, setPercent] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [importExportError, setImportExportError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [documents, setDocuments] = useState<CvDocumentSummary[]>([]);
  const [activeDocumentId, setActiveDocumentIdRaw] = useState<string | null>(null);
  const activeDocumentIdRef = useRef<string | null>(null);

  function setActiveDocumentId(id: string | null) {
    activeDocumentIdRef.current = id;
    setActiveDocumentIdRaw(id);
  }
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [supabase] = useState(() => getSupabaseBrowserClient());
  const [session, setSession] = useState<import("@supabase/supabase-js").Session | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("idle");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<AuthModalMode | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [signupTermsAccepted, setSignupTermsAccepted] = useState(false);
  const [termsStatus, setTermsStatus] = useState<TermsStatus>("unknown");
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const [termsModalChecked, setTermsModalChecked] = useState(false);
  const [termsModalError, setTermsModalError] = useState<string | null>(null);
  const [termsAccepting, setTermsAccepting] = useState(false);
  const encryptionModal = useEncryptionModal();
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const initializedRef = useRef(false);
  const isResettingRef = useRef(false);
  const renderId = useRef(0);
  const pendingTermsAcceptanceKey = `typst-cv-builder:pending-terms-acceptance`;

  const form = useForm<CvData>({
    resolver: zodResolver(cvSchema),
    defaultValues: cloneCvData(sampleCvData),
    mode: "onChange",
  });

  const watchedData = useWatch({ control: form.control });
  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, documents],
  );
  const supabaseConfigured = Boolean(supabase);
  const cloudActionsEnabled = Boolean(supabase && session);

  // ── helpers ──────────────────────────────────────────────────────

  function setOrderedDocuments(
    nextDocuments: CvDocumentSummary[] | ((current: CvDocumentSummary[]) => CvDocumentSummary[]),
  ) {
    setDocuments((current) => {
      const next = typeof nextDocuments === "function" ? nextDocuments(current) : nextDocuments;
      return sortCvDocumentSummariesByStoredOrder(next);
    });
  }

  function reorderDocuments(fromIndex: number, toIndex: number) {
    setDocuments((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) {
        return current;
      }

      next.splice(toIndex, 0, moved);
      storeCvDocumentOrder(next);
      return next;
    });
  }

  function upsertDocumentSummary(summary: CvDocumentSummary) {
    setOrderedDocuments((current) =>
      current.some((item) => item.id === summary.id)
        ? current.map((item) => (item.id === summary.id ? summary : item))
        : [summary, ...current],
    );
  }

  function replaceLocalDocumentSummary(document: LocalCvDocument) {
    upsertDocumentSummary(summarizeLocalDocument(document));
  }

  function replaceCloudSummaries(cloudDocuments: CvDocumentSummary[]) {
    setOrderedDocuments((current) => [
      ...cloudDocuments,
      ...current.filter((document) => document.storageKind === "local"),
    ]);
  }

  function removeCloudSummaries() {
    setOrderedDocuments((current) => current.filter((document) => document.storageKind === "local"));
  }

  function getEncryptionPassphrase(id: string) {
    const userId = session?.user.id;
    if (!userId) {
      throw new Error("Enter the encryption password to unlock this CV.");
    }

    const passphrase = loadEncryptionPassword(userId, id);
    if (!passphrase) {
      throw new Error("Enter the encryption password to unlock this CV.");
    }

    return passphrase;
  }

  function hasKnownEncryptionPassphrase(id: string) {
    const userId = session?.user.id;
    if (!userId) {
      return false;
    }

    return Boolean(loadEncryptionPassword(userId, id));
  }

  function loadDataIntoForm(id: string, data: CvData) {
    renderId.current += 1;
    isResettingRef.current = true;
    setActiveDocumentId(id);
    saveActiveCvDocumentId(id);
    form.reset(data);
    setSvg(null);
    setStatus("idle");
    setPreviewError(null);
    setLibraryError(null);
    setIsDirty(false);
  }

  useEffect(() => {
    if (!initializedRef.current) {
      return;
    }

    storeCvDocumentOrder(documents);
  }, [documents]);

  // ── cloud draft ──────────────────────────────────────────────────

  function draftKey(userId: string, cvId: string) {
    return `typst-cv-builder:draft:${userId}:${cvId}`;
  }

  function saveDraft(cvId: string, data: CvData) {
    const userId = session?.user.id;
    if (!userId) return;

    try {
      window.localStorage.setItem(draftKey(userId, cvId), JSON.stringify(data));
    } catch {
      // localStorage full or unavailable — non-critical, skip
    }
  }

  function loadDraft(cvId: string): CvData | null {
    const userId = session?.user.id;
    if (!userId) return null;

    try {
      const raw = window.localStorage.getItem(draftKey(userId, cvId));
      if (!raw) return null;
      const parsed = persistedCvSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  function clearDraft(cvId: string) {
    const userId = session?.user.id;
    if (!userId) return;

    window.localStorage.removeItem(draftKey(userId, cvId));
  }

  // ── terms ────────────────────────────────────────────────────────

  function promptForTermsAcceptance() {
    setTermsStatus("required");
    setTermsModalOpen(true);
    setTermsModalChecked(false);
    setTermsModalError(null);
  }

  function markPendingTermsAcceptance() {
    window.sessionStorage.setItem(pendingTermsAcceptanceKey, TERMS_VERSION);
  }

  function consumePendingTermsAcceptance() {
    if (window.sessionStorage.getItem(pendingTermsAcceptanceKey) !== TERMS_VERSION) {
      return false;
    }

    window.sessionStorage.removeItem(pendingTermsAcceptanceKey);
    return true;
  }

  function clearPendingTermsAcceptance() {
    window.sessionStorage.removeItem(pendingTermsAcceptanceKey);
  }

  async function refreshTermsAcceptance(
    client: SupabaseClient,
    { showModal = true }: { showModal?: boolean } = {},
  ) {
    try {
      let accepted = await hasAcceptedCurrentTerms(client);
      if (!accepted && consumePendingTermsAcceptance()) {
        await acceptCurrentTerms(client);
        accepted = true;
      }

      setTermsStatus(accepted ? "accepted" : "required");
      if (!accepted && showModal) {
        promptForTermsAcceptance();
      }
      return accepted;
    } catch (termsError) {
      setTermsStatus("unknown");
      setLibraryError(errorMessage(termsError));
      return false;
    }
  }

  async function ensureTermsAccepted(client: SupabaseClient | null = supabase) {
    if (!client || !session) {
      return false;
    }

    if (termsStatus === "accepted") {
      return true;
    }

    const accepted = await refreshTermsAcceptance(client);
    if (!accepted) {
      promptForTermsAcceptance();
    }
    return accepted;
  }

  async function acceptTerms() {
    if (!supabase || !session) {
      setTermsModalError("Sign in before accepting the Terms and Privacy Notice.");
      return;
    }

    if (!termsModalChecked) {
      setTermsModalError("Check the box before accepting.");
      return;
    }

    setTermsAccepting(true);
    setTermsModalError(null);

    try {
      await acceptCurrentTerms(supabase);
      setTermsStatus("accepted");
      setTermsModalOpen(false);
      setTermsModalChecked(false);
      await refreshCloudDocuments(supabase, { skipTermsCheck: true });
    } catch (termsError) {
      setTermsModalError(errorMessage(termsError));
    } finally {
      setTermsAccepting(false);
    }
  }

  // ── cloud sync ───────────────────────────────────────────────────

  async function refreshCloudDocuments(
    client: SupabaseClient | null = supabase,
    { skipTermsCheck = false }: { skipTermsCheck?: boolean } = {},
  ) {
    if (!client) {
      return;
    }

    if (!skipTermsCheck && !(await ensureTermsAccepted(client))) {
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
        setLibraryCollapsed(loadCvLibraryCollapsed());
        initializedRef.current = true;
        return;
      }

      // Cloud/encrypted CV: keep the ID, let refreshCloudDocuments load it later
      if (!initialDocument && isCloudActive && library.activeDocumentId) {
        setOrderedDocuments(library.documents);
        setActiveDocumentId(library.activeDocumentId);
        setLibraryCollapsed(loadCvLibraryCollapsed());
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
      setLibraryCollapsed(loadCvLibraryCollapsed());
      form.reset(documentToLoad.data);
      initializedRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, [form]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const client = supabase;
    let cancelled = false;

    async function loadInitialSession() {
      const { data, error } = await client.auth.getSession();
      if (cancelled) {
        return;
      }

      if (error) {
        setCloudStatus("error");
        setLibraryError(error.message);
        return;
      }

      setSession(data.session);
      if (data.session) {
        encryptionModal.setTrustDevice(loadTrustDevice(data.session.user.id));
        const accepted = await refreshTermsAcceptance(client);
        if (accepted) {
          await refreshCloudDocuments(client, { skipTermsCheck: true });
        } else {
          removeCloudSummaries();
          setCloudStatus("idle");
        }
      }
    }

    void loadInitialSession();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        encryptionModal.setTrustDevice(loadTrustDevice(nextSession.user.id));
        void (async () => {
          const accepted = await refreshTermsAcceptance(client);
          if (accepted) {
            await refreshCloudDocuments(client, { skipTermsCheck: true });
          } else {
            removeCloudSummaries();
            setCloudStatus("idle");
          }
        })();
      } else {
        removeCloudSummaries();
        setTermsStatus("unknown");
        setTermsModalOpen(false);
        setTermsModalChecked(false);
        setTermsModalError(null);
        setSignupTermsAccepted(false);
        setCloudStatus("idle");
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
    // refreshCloudDocuments is intentionally not a dependency; this subscription is bound to the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  async function saveCurrentDocument({ silent = false }: { silent?: boolean } = {}) {
    if (!activeDocumentId || !activeDocument) {
      return false;
    }

    if (saving) {
      return false;
    }

    const parsed = cvSchema.safeParse(form.getValues());
    if (!parsed.success) {
      setLibraryError("The current form data does not match the CV schema.");
      return false;
    }

    void silent;

    setSaving(true);
    try {
      if (activeDocument.storageKind === "local") {
        const updated = updateLocalCvDocumentData(activeDocumentId, parsed.data);
        if (!updated) {
          throw new Error("The active CV could not be saved.");
        }

        replaceLocalDocumentSummary(updated);
      } else if (activeDocument.storageKind === "cloud") {
        if (!supabase || !session) {
          throw new Error("Sign in before saving this cloud CV.");
        }

        if (!(await ensureTermsAccepted())) {
          return false;
        }

        const updated = await updateCloudCvDocumentData(supabase, activeDocumentId, parsed.data);
        upsertDocumentSummary(updated);
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before saving this encrypted CV.");
        }

        if (!(await ensureTermsAccepted())) {
          return false;
        }

        if (!hasKnownEncryptionPassphrase(activeDocumentId)) {
          encryptionModal.openModal("unlock", activeDocumentId);
          return false;
        }

        const passphrase = getEncryptionPassphrase(activeDocumentId);
        const encryptedPayload = await encryptCvData(parsed.data, passphrase);
        const updated = await updateEncryptedCloudCvDocumentData(supabase, activeDocumentId, {
          encryptedPayload,
          schemaVersion: parsed.data.schemaVersion,
        });
        upsertDocumentSummary(updated);
      }
    } catch (saveError) {
      setLibraryError(errorMessage(saveError));
      return false;
    } finally {
      setSaving(false);
    }

    setIsDirty(false);
    if (activeDocument.storageKind === "cloud") {
      clearDraft(activeDocumentId);
    }
    return true;
  }

  async function discardChanges() {
    if (!activeDocumentId || !activeDocument) {
      return;
    }

    try {
      if (activeDocument.storageKind === "cloud") {
        if (!supabase || !session) {
          throw new Error("Sign in before discarding changes.");
        }

        if (!(await ensureTermsAccepted())) {
          return;
        }

        clearDraft(activeDocumentId);
        const document = await loadCloudCvDocument(supabase, activeDocumentId);
        loadDataIntoForm(document.id, document.data);
      } else if (activeDocument.storageKind === "encrypted") {
        if (!supabase || !session) {
          throw new Error("Sign in before discarding changes.");
        }

        if (!(await ensureTermsAccepted())) {
          return;
        }

        const passphrase = getEncryptionPassphrase(activeDocumentId);
        const document = await loadEncryptedCloudCvDocument(supabase, activeDocumentId);
        const decryptedData = await decryptCvData(document.encryptedPayload, passphrase);
        loadDataIntoForm(document.id, decryptedData);
      }
    } catch (discardError) {
      setLibraryError(errorMessage(discardError));
    }
  }

  useEffect(() => {
    if (!initializedRef.current || !activeDocumentId) {
      return;
    }

    const timer = window.setTimeout(async () => {
      const isResetting = isResettingRef.current;
      if (isResetting) {
        isResettingRef.current = false;
      }

      const parsed = cvSchema.safeParse(form.getValues());
      if (!parsed.success) {
        setStatus("error");
        setPreviewError("The current form data does not match the CV schema.");
        return;
      }

      // Auto-save: only for local CVs (skip during reset)
      if (!isResetting) {
        if (activeDocument?.storageKind === "local") {
          const saved = await saveCurrentDocument({ silent: true });
          if (!saved) {
            return;
          }
        } else if (activeDocument?.storageKind === "cloud") {
          // Cloud CVs: save draft to localStorage as safety net
          saveDraft(activeDocumentId, parsed.data);
          setIsDirty(true);
        } else {
          // Encrypted CVs: no auto-save, no draft
          setIsDirty(true);
        }
      }

      // Always render preview
      const nextRenderId = renderId.current + 1;
      renderId.current = nextRenderId;
      setStatus("loading-assets");
      setPercent(0);
      setPreviewError(null);

      try {
        const document = buildTypstDocument(parsed.data);
        const nextSvg = await renderTypstSvg(document, (progress) => {
          if (renderId.current === nextRenderId) {
            setStatus(progress.stage);
            setPercent(progress.percent);
          }
        });
        if (renderId.current === nextRenderId) {
          setSvg(nextSvg);
          setStatus("ready");
          setPercent(null);
        }
      } catch (renderError) {
        if (renderId.current === nextRenderId) {
          setStatus("error");
          setPercent(null);
          setPreviewError(errorMessage(renderError));
        }
      }
    }, 500);

    return () => window.clearTimeout(timer);
    // saveCurrentDocument updates document summaries, so depending on it would retrigger saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedData, form, activeDocumentId, activeDocument?.storageKind]);

  // ── auth ─────────────────────────────────────────────────────────

  async function signIn() {
    if (!supabase) {
      setAuthError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authEmail || !authPassword) {
      setAuthError("Enter email and password before signing in.");
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password: authPassword,
    });

    if (signInError) {
      setAuthError(signInError.message);
    } else {
      setAuthError(null);
      setAuthPassword("");
      setAuthModalMode(null);
      setAccountMenuOpen(false);
    }
  }

  async function signUp() {
    if (!supabase) {
      setAuthError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authEmail || !authPassword) {
      setAuthError("Enter email and password before creating an account.");
      return;
    }

    if (!signupTermsAccepted) {
      setAuthError("Agree to the Terms of Use and acknowledge the Privacy Policy before continuing.");
      return;
    }

    markPendingTermsAcceptance();

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: authEmail,
      password: authPassword,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    if (signUpError) {
      clearPendingTermsAcceptance();
      setAuthError(signUpError.message);
      return;
    }

    if (!data.session) {
      setAuthError(null);
      setSuccessMessage("Account created. Check your email before signing in.");
    } else {
      try {
        await acceptCurrentTerms(supabase);
        setTermsStatus("accepted");
        clearPendingTermsAcceptance();
      } catch (termsError) {
        setAuthError(errorMessage(termsError));
        return;
      }

      setAuthError(null);
      setAuthPassword("");
      setSignupTermsAccepted(false);
      setAuthModalMode(null);
      setAccountMenuOpen(false);
    }
  }

  async function signInWithGithub() {
    if (!supabase) {
      setAuthError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (authModalMode === "signUp") {
      if (!signupTermsAccepted) {
        setAuthError("Agree to the Terms of Use and acknowledge the Privacy Policy before continuing.");
        return;
      }

      markPendingTermsAcceptance();
    }

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (oauthError) {
      if (authModalMode === "signUp") {
        clearPendingTermsAcceptance();
      }
      setAuthError(oauthError.message);
    }
  }

  async function signOut() {
    if (!supabase) {
      return;
    }

    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setAuthError(signOutError.message);
      return;
    }

    if (session?.user.id) {
      clearEncryptionPasswords(window.sessionStorage, session.user.id);
      clearEncryptionPasswords(window.localStorage, session.user.id);
    }
    encryptionModal.closeModal();
    setAccountMenuOpen(false);

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
      if (!(await saveCurrentDocument({ silent: true }))) {
        return;
      }
    }

    const documentSummary = documents.find((document) => document.id === id);
    if (!documentSummary) {
      setLibraryError("The selected CV could not be loaded.");
      return;
    }

    try {
      if (documentSummary.storageKind === "local") {
        const document = loadCvDocument(id);
        if (!document) {
          throw new Error("The selected local CV could not be loaded.");
        }

        loadDataIntoForm(document.id, document.data);
      } else if (documentSummary.storageKind === "cloud") {
        if (!supabase || !session) {
          throw new Error("Sign in before opening this cloud CV.");
        }

        if (!(await ensureTermsAccepted())) {
          return;
        }

        const document = await loadCloudCvDocument(supabase, id);
        upsertDocumentSummary(document);
        // Check for local draft first
        const draft = loadDraft(id);
        loadDataIntoForm(document.id, draft ?? document.data);
        if (draft) {
          setIsDirty(true);
        }
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before opening this encrypted CV.");
        }

        if (!(await ensureTermsAccepted())) {
          return;
        }

        if (!hasKnownEncryptionPassphrase(id)) {
          encryptionModal.openModal("unlock", id);
          return;
        }

        const passphrase = getEncryptionPassphrase(id);
        const document = await loadEncryptedCloudCvDocument(supabase, id);
        const decryptedData = await decryptCvData(document.encryptedPayload, passphrase);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, decryptedData);
      }
    } catch (loadError) {
      setLibraryError(errorMessage(loadError));
    }
  }

  async function createDocumentFromData(data: CvData, title: string) {
    if (activeDocumentId) {
      await saveCurrentDocument({ silent: true });
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

    try {
      if (current.storageKind === "local") {
        const nextTitle = window.prompt("Rename CV", current.title);
        if (!nextTitle) {
          return;
        }

        setOrderedDocuments((existing) => {
          const updatedLocalDocuments = renameCvDocument(id, nextTitle);
          const updatedLocal = updatedLocalDocuments.find((document) => document.id === id);

          return existing.map((document) =>
            document.id === id && updatedLocal ? updatedLocal : document,
          );
        });
      } else if (current.storageKind === "cloud" || current.storageKind === "encrypted") {
        if (!supabase || !session) {
          throw new Error("Sign in before renaming this cloud CV.");
        }

        if (!(await ensureTermsAccepted())) {
          return;
        }

        const nextTitle = window.prompt("Rename CV", current.title);
        if (!nextTitle) {
          return;
        }

        const updated = await renameCloudCvDocument(supabase, id, nextTitle);
        upsertDocumentSummary(updated);
      }
    } catch (renameError) {
      setLibraryError(errorMessage(renameError));
    }
  }

  async function duplicateDocument(id: string, passphraseOverride?: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    try {
      let data: CvData;
      let title: string | undefined;

      if (current.storageKind === "local") {
        const source = loadCvDocument(id);
        if (!source) {
          throw new Error("The selected CV could not be duplicated.");
        }
        data = source.data;
        title = `${source.title} Copy`;
      } else if (current.storageKind === "cloud") {
        if (!supabase || !session) {
          throw new Error("Sign in before duplicating this cloud CV.");
        }

        if (!(await ensureTermsAccepted())) {
          return;
        }

        const source = await loadCloudCvDocument(supabase, id);
        data = source.data;
        title = `${source.title} Copy`;
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before duplicating this encrypted CV.");
        }

        if (!(await ensureTermsAccepted())) {
          return;
        }

        if (!passphraseOverride && !hasKnownEncryptionPassphrase(id)) {
          encryptionModal.openModal("duplicate", id);
          return;
        }

        const passphrase = passphraseOverride ?? getEncryptionPassphrase(id);
        const source = await loadEncryptedCloudCvDocument(supabase, id);
        data = await decryptCvData(source.encryptedPayload, passphrase);
        title = `${source.title} Copy`;
      }

      const document = createLocalCvDocument(data, title);
      replaceLocalDocumentSummary(document);
      loadDataIntoForm(document.id, document.data);
    } catch (duplicateError) {
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
      if (current.storageKind === "local") {
        removeCvDocument(id);
      } else if (current.storageKind === "cloud" || current.storageKind === "encrypted") {
        if (!supabase || !session) {
          throw new Error("Sign in before deleting this cloud CV.");
        }

        await deleteCloudCvDocument(supabase, id);
      }

      const nextDocuments = documents.filter((document) => document.id !== id);
      setOrderedDocuments(nextDocuments);

      if (id === activeDocumentId) {
        setActiveDocumentId(null);
        saveActiveCvDocumentId(null);
        renderId.current += 1;
        form.reset(createEmptyCvData());
        setSvg(null);
        setStatus("idle");
        setPreviewError(null);
        setLibraryError(null);
        setIsDirty(false);
      }
    } catch (deleteError) {
      setLibraryError(errorMessage(deleteError));
    }
  }

  function toggleLibraryCollapsed() {
    const nextCollapsed = !libraryCollapsed;
    setLibraryCollapsed(nextCollapsed);
    storeCvLibraryCollapsed(nextCollapsed);
  }

  // ── cloud operations ─────────────────────────────────────────────

  async function moveToCloud(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    if (!supabase || !session) {
      setLibraryError("Sign in before moving a CV to cloud storage.");
      return;
    }

    if (!(await ensureTermsAccepted())) {
      return;
    }

    if (current.storageKind !== "local") {
      return;
    }

    try {
      if (id === activeDocumentId) {
        await saveCurrentDocument({ silent: true });
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

    if (!(await ensureTermsAccepted())) {
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
        await saveCurrentDocument({ silent: true });
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

    if (!(await ensureTermsAccepted())) {
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

    if (!(await ensureTermsAccepted())) {
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

  function downloadJsonData(data: CvData, title: string) {
    const payload = JSON.stringify(data, null, 2);
    downloadBlob(new Blob([payload], { type: "application/json" }), safeDownloadName(title || "cv-data", "json"));
  }

  async function ensureLocalFontsForData(data: CvData) {
    const families = selectedFontFamilies(data);
    if (families.length === 0) return;

    const fontData = await loadLocalFontData(families);
    for (const data of fontData) {
      addFontFromData(data);
    }
  }

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

  async function downloadPdf() {
    if (!activeDocumentId || !activeDocument) {
      return;
    }

    setExportingFormat("pdf");
    setPreviewError(null);

    try {
      const data = getCurrentCvData();
      await ensureLocalFontsForData(data);
      const document = buildTypstDocument(data);
      const pdf = await renderTypstPdf(document);
      downloadBlob(
        new Blob([toArrayBuffer(pdf)], { type: "application/pdf" }),
        safeDownloadName(currentDownloadTitle(data), "pdf"),
      );
    } catch (pdfError) {
      setPreviewError(errorMessage(pdfError));
    } finally {
      setExportingFormat(null);
    }
  }

  async function exportDocument() {
    if (!activeDocumentId || !activeDocument) {
      return;
    }

    setExportingFormat("json");

    try {
      const data = getCurrentCvData();
      downloadJsonData(data, currentDownloadTitle(data));
    } catch (exportError) {
      setImportExportError(errorMessage(exportError));
    } finally {
      setExportingFormat(null);
    }
  }

  async function exportTypstSource() {
    if (!activeDocumentId || !activeDocument) {
      return;
    }

    setExportingFormat("typst-source");

    try {
      const data = getCurrentCvData();
      const source = buildTypstDocument(data, { styleImportPath: "style.typ" });
      downloadBlob(
        new Blob([source], { type: "text/plain;charset=utf-8" }),
        safeDownloadName(currentDownloadTitle(data), "typ"),
      );
    } catch (exportError) {
      setImportExportError(errorMessage(exportError));
    } finally {
      setExportingFormat(null);
    }
  }

  async function exportTypstPackage() {
    if (!activeDocumentId || !activeDocument) {
      return;
    }

    setExportingFormat("typst-package");

    try {
      const data = getCurrentCvData();
      const styleSource = await fetchStyleSource();
      const source = buildTypstDocument(data, { styleImportPath: "style.typ" });
      const zip = createZip({
        "resume.typ": source,
        "style.typ": styleSource,
        "data.json": JSON.stringify(data, null, 2),
        "README.txt": buildTypstPackageReadme(),
      });

      downloadBlob(
        new Blob([toArrayBuffer(zip)], { type: "application/zip" }),
        safeDownloadName(`${currentDownloadTitle(data)} typst package`, "zip"),
      );
    } catch (exportError) {
      setImportExportError(errorMessage(exportError));
    } finally {
      setExportingFormat(null);
    }
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
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  }

  // ── return ───────────────────────────────────────────────────────

  return {
    // state
    svg,
    status,
    percent,
    previewError,
    authError,
    libraryError,
    importExportError,
    successMessage,
    documents,
    activeDocumentId,
    activeDocument,
    isDirty,
    saving,
    exportingFormat,
    libraryCollapsed,
    session,
    cloudStatus,
    accountMenuOpen,
    supabaseConfigured,
    cloudActionsEnabled,
    authModalMode,
    authEmail,
    authPassword,
    signupTermsAccepted,
    termsStatus,
    termsModalOpen,
    termsModalChecked,
    termsModalError,
    termsAccepting,
    encryptionModal,
    importInputRef,
    form,

    // setters
    setAccountMenuOpen,
    setAuthModalMode,
    setAuthEmail,
    setAuthPassword,
    setSignupTermsAccepted,
    setTermsModalOpen,
    setTermsModalChecked,
    setTermsModalError,
    setAuthError,
    setLibraryError,
    setImportExportError,
    setSuccessMessage,

    // actions
    signIn,
    signUp,
    signInWithGithub,
    acceptTerms,
    signOut,
    saveCurrentDocument,
    discardChanges,
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
    downloadPdf,
    exportTypstPackage,
    exportTypstSource,
    exportDocument,
  };
}
