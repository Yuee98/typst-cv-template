"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  Cloud,
  LogIn,
  LogOut,
  Printer,
  Save,
  ShieldCheck,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Toolbar, ToolbarGroup, ToolbarTitle } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { CvEditor } from "@/components/cv-builder/editors";
import { CvLibrarySidebar } from "@/components/cv-builder/cv-library-sidebar";
import { PreviewPane, type PreviewStatus } from "@/components/cv-builder/preview-pane";
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
import { decryptCvData, encryptCvData } from "@/lib/cv/encryption";
import { buildTypstDocument } from "@/lib/cv/typst";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import { sampleCvData } from "@/lib/cv/sample-data";
import {
  createLocalCvDocument,
  initializeCvDocumentLibrary,
  loadCvDocument,
  loadCvLibraryCollapsed,
  removeCvDocument,
  renameCvDocument,
  saveActiveCvDocumentId,
  storeCvLibraryCollapsed,
  type CvDocumentSummary,
  type LocalCvDocument,
  updateLocalCvDocumentData,
} from "@/lib/cv/storage";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { renderTypstSvg } from "@/lib/typst/render";

type CloudStatus = "idle" | "loading" | "ready" | "error";
type AuthModalMode = "signIn" | "signUp";
type EncryptionModalMode = "enable" | "unlock" | "export" | "duplicate";
type EncryptionModalState = {
  mode: EncryptionModalMode;
  documentId: string;
};
const ENCRYPTION_SESSION_KEY_PREFIX = "typst-cv-builder:encryption-session:";
const ENCRYPTION_SESSION_REMEMBER_KEY = "typst-cv-builder:encryption-session:remember";
const ENCRYPTION_DEVICE_KEY_PREFIX = "typst-cv-builder:encryption-device:";

function cloneCvData(data: CvData): CvData {
  return JSON.parse(JSON.stringify(data)) as CvData;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function summarizeLocalDocument(document: LocalCvDocument): CvDocumentSummary {
  return {
    id: document.id,
    title: document.title,
    storageKind: document.storageKind,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function titleFromImportedData(data: CvData) {
  const name = data.header.name.trim();
  return name ? `${name} CV` : "Imported CV";
}

function createEmptyCvData(): CvData {
  return {
    schemaVersion: 5,
    typstLang: sampleCvData.typstLang,
    bodyFont: sampleCvData.bodyFont,
    header: {
      name: "",
      subtitle: "",
      email: "",
      phone: "",
      selfName: "",
    },
    sectionTitles: cloneCvData(sampleCvData).sectionTitles,
    profile: [],
    skills: [],
    experience: [],
    education: [],
    research: [],
    publications: [],
    additional: [],
  };
}

function encryptionSessionKey(id: string) {
  return `${ENCRYPTION_SESSION_KEY_PREFIX}${id}`;
}

function encryptionDeviceKey(id: string) {
  return `${ENCRYPTION_DEVICE_KEY_PREFIX}${id}`;
}

function encodeStoredPassphrase(passphrase: string) {
  return btoa(encodeURIComponent(passphrase));
}

function decodeStoredPassphrase(stored: string) {
  try {
    return decodeURIComponent(atob(stored));
  } catch {
    return null;
  }
}

function loadSessionEncryptionPassword(id: string) {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage.getItem(encryptionSessionKey(id));
}

function storeSessionEncryptionPassword(id: string, passphrase: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(encryptionSessionKey(id), passphrase);
}

function loadDeviceEncryptionPassword(id: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = window.localStorage.getItem(encryptionDeviceKey(id));
  return stored ? decodeStoredPassphrase(stored) : null;
}

function storeDeviceEncryptionPassword(id: string, passphrase: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(encryptionDeviceKey(id), encodeStoredPassphrase(passphrase));
}

function clearSessionEncryptionPasswords() {
  if (typeof window === "undefined") {
    return;
  }

  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith(ENCRYPTION_SESSION_KEY_PREFIX)) {
      window.sessionStorage.removeItem(key);
    }
  }
}

function loadRememberEncryptionSession() {
  if (typeof window === "undefined") {
    return true;
  }

  const stored = window.sessionStorage.getItem(ENCRYPTION_SESSION_REMEMBER_KEY);
  return stored === null ? true : stored === "true";
}

function storeRememberEncryptionSession(remember: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  if (remember) {
    window.sessionStorage.setItem(ENCRYPTION_SESSION_REMEMBER_KEY, "true");
  } else {
    window.sessionStorage.removeItem(ENCRYPTION_SESSION_REMEMBER_KEY);
  }
}

export function CvBuilder() {
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<CvDocumentSummary[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [supabase] = useState(() => getSupabaseBrowserClient());
  const [session, setSession] = useState<Session | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("idle");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<AuthModalMode | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [encryptionPassword, setEncryptionPassword] = useState("");
  const [encryptionModalError, setEncryptionModalError] = useState<string | null>(null);
  const [rememberEncryptionSession, setRememberEncryptionSession] = useState(loadRememberEncryptionSession);
  const [trustEncryptionDevice, setTrustEncryptionDevice] = useState(false);
  const [encryptionModal, setEncryptionModal] = useState<EncryptionModalState | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const encryptedPasswordsRef = useRef<Record<string, string>>({});
  const initializedRef = useRef(false);
  const renderId = useRef(0);

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

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      const library = initializeCvDocumentLibrary(cloneCvData(sampleCvData));
      const initialDocument = library.activeDocumentId ? loadCvDocument(library.activeDocumentId) : null;

      if (!initialDocument && library.documents.length === 0) {
        const document = createLocalCvDocument(createEmptyCvData(), "Untitled CV");
        setDocuments([summarizeLocalDocument(document)]);
        setActiveDocumentId(document.id);
        saveActiveCvDocumentId(document.id);
        setLibraryCollapsed(loadCvLibraryCollapsed());
        form.reset(document.data);
        initializedRef.current = true;
        return;
      }

      const documentToLoad = initialDocument ?? createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
      const nextDocuments = initialDocument
        ? library.documents
        : [summarizeLocalDocument(documentToLoad), ...library.documents];

      setDocuments(nextDocuments);
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

  const previousActiveIdRef = useRef<string | null>(null);
  useEffect(() => {
    const previousId = previousActiveIdRef.current;
    previousActiveIdRef.current = activeDocumentId;

    if (!previousId || previousId === activeDocumentId) {
      return;
    }

    const previousDoc = documents.find((document) => document.id === previousId);
    if (previousDoc?.storageKind !== "encrypted" || rememberEncryptionSession) {
      return;
    }

    delete encryptedPasswordsRef.current[previousId];
  }, [activeDocumentId, documents, rememberEncryptionSession]);

  function upsertDocumentSummary(summary: CvDocumentSummary) {
    setDocuments((current) =>
      current.some((item) => item.id === summary.id)
        ? current.map((item) => (item.id === summary.id ? summary : item))
        : [summary, ...current],
    );
  }

  function replaceLocalDocumentSummary(document: LocalCvDocument) {
    upsertDocumentSummary(summarizeLocalDocument(document));
  }

  function replaceCloudSummaries(cloudDocuments: CvDocumentSummary[]) {
    setDocuments((current) => [
      ...cloudDocuments,
      ...current.filter((document) => document.storageKind === "local"),
    ]);
  }

  function removeCloudSummaries() {
    setDocuments((current) => current.filter((document) => document.storageKind === "local"));
  }

  async function refreshCloudDocuments(client: SupabaseClient | null = supabase) {
    if (!client) {
      return;
    }

    setCloudStatus("loading");

    try {
      const cloudDocuments = await listCloudCvDocuments(client);
      replaceCloudSummaries(cloudDocuments);
      if (!activeDocumentId && cloudDocuments[0]?.storageKind === "cloud") {
        const document = await loadCloudCvDocument(client, cloudDocuments[0].id);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, document.data);
      }
      setCloudStatus("ready");
    } catch (cloudError) {
      setCloudStatus("error");
      setStatus("error");
      setError(errorMessage(cloudError));
    }
  }

  function getEncryptionPassphrase(id: string) {
    const passphrase =
      encryptedPasswordsRef.current[id] ?? loadSessionEncryptionPassword(id) ?? loadDeviceEncryptionPassword(id);

    if (!passphrase) {
      throw new Error("Enter the encryption password to unlock this CV.");
    }

    if (passphrase) {
      encryptedPasswordsRef.current[id] = passphrase;
    }

    return passphrase;
  }

  function hasKnownEncryptionPassphrase(id: string) {
    return Boolean(
      encryptedPasswordsRef.current[id] ?? loadSessionEncryptionPassword(id) ?? loadDeviceEncryptionPassword(id),
    );
  }

  function rememberEncryptionPassphrase(id: string, passphrase: string) {
    encryptedPasswordsRef.current[id] = passphrase;
    if (rememberEncryptionSession) {
      storeSessionEncryptionPassword(id, passphrase);
    }
    if (trustEncryptionDevice) {
      storeDeviceEncryptionPassword(id, passphrase);
    }
  }

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
        setError(error.message);
        return;
      }

      setSession(data.session);
      if (data.session) {
        await refreshCloudDocuments(client);
      }
    }

    void loadInitialSession();

    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        void refreshCloudDocuments(client);
      } else {
        removeCloudSummaries();
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

  async function signIn() {
    if (!supabase) {
      setStatus("error");
      setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authEmail || !authPassword) {
      setStatus("error");
      setError("Enter email and password before signing in.");
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password: authPassword,
    });

    if (signInError) {
      setStatus("error");
      setError(signInError.message);
    } else {
      setAuthPassword("");
      setAuthModalMode(null);
      setAccountMenuOpen(false);
    }
  }

  async function signUp() {
    if (!supabase) {
      setStatus("error");
      setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    if (!authEmail || !authPassword) {
      setStatus("error");
      setError("Enter email and password before creating an account.");
      return;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: authEmail,
      password: authPassword,
    });

    if (signUpError) {
      setStatus("error");
      setError(signUpError.message);
      return;
    }

    if (!data.session) {
      setStatus("error");
      setError("Account created. Check your email before signing in.");
    } else {
      setAuthPassword("");
      setAuthModalMode(null);
      setAccountMenuOpen(false);
    }
  }

  async function signInWithGithub() {
    if (!supabase) {
      setStatus("error");
      setError("Supabase is not configured. Add web/.env.local to enable cloud storage.");
      return;
    }

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (oauthError) {
      setStatus("error");
      setError(oauthError.message);
    }
  }

  async function signOut() {
    if (!supabase) {
      return;
    }

    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setStatus("error");
      setError(signOutError.message);
      return;
    }

    encryptedPasswordsRef.current = {};
    clearSessionEncryptionPasswords();
    storeRememberEncryptionSession(false);
    setRememberEncryptionSession(false);
    setEncryptionPassword("");
    setAccountMenuOpen(false);

    const localDocuments = documents.filter((document) => document.storageKind === "local");
    const activeIsCloudBacked = activeDocument?.storageKind === "cloud" || activeDocument?.storageKind === "encrypted";
    if (activeIsCloudBacked || localDocuments.length === 0) {
      const parsed = cvSchema.safeParse(form.getValues());
      const fallbackData = parsed.success ? parsed.data : cloneCvData(sampleCvData);
      const fallbackTitle = activeDocument?.title ?? titleFromImportedData(fallbackData);
      const localDocument = createLocalCvDocument(fallbackData, fallbackTitle);
      setDocuments([summarizeLocalDocument(localDocument), ...localDocuments]);
      loadDataIntoForm(localDocument.id, localDocument.data);
    } else {
      setDocuments(localDocuments);
    }
  }

  async function saveCurrentDocument({ silent = false }: { silent?: boolean } = {}) {
    if (!activeDocumentId || !activeDocument) {
      return false;
    }

    const parsed = cvSchema.safeParse(form.getValues());
    if (!parsed.success) {
      setStatus("error");
      setError("The current form data does not match the CV schema.");
      return false;
    }

    void silent;

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

        const updated = await updateCloudCvDocumentData(supabase, activeDocumentId, parsed.data);
        upsertDocumentSummary(updated);
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before saving this encrypted CV.");
        }

        if (!hasKnownEncryptionPassphrase(activeDocumentId)) {
          setEncryptionModal({ mode: "unlock", documentId: activeDocumentId });
          setEncryptionPassword("");
          setEncryptionModalError(null);
          return false;
        }

        const passphrase = getEncryptionPassphrase(activeDocumentId);
        const encryptedPayload = await encryptCvData(parsed.data, passphrase);
        const updated = await updateEncryptedCloudCvDocumentData(supabase, activeDocumentId, {
          encryptedPayload,
          schemaVersion: parsed.data.schemaVersion,
        });
        rememberEncryptionPassphrase(activeDocumentId, passphrase);
        upsertDocumentSummary(updated);
      }
    } catch (saveError) {
      setStatus("error");
      setError(errorMessage(saveError));
      return false;
    }

    return true;
  }

  useEffect(() => {
    if (!initializedRef.current || !activeDocumentId) {
      return;
    }

    const timer = window.setTimeout(async () => {
      const parsed = cvSchema.safeParse(form.getValues());
      if (!parsed.success) {
        setStatus("error");
        setError("The current form data does not match the CV schema.");
        return;
      }

      const saved = await saveCurrentDocument({ silent: true });
      if (!saved) {
        return;
      }

      const nextRenderId = renderId.current + 1;
      renderId.current = nextRenderId;
      setStatus("rendering");
      setError(null);

      try {
        const document = buildTypstDocument(parsed.data);
        const nextSvg = await renderTypstSvg(document);
        if (renderId.current === nextRenderId) {
          setSvg(nextSvg);
          setStatus("ready");
        }
      } catch (renderError) {
        if (renderId.current === nextRenderId) {
          setStatus("error");
          setError(errorMessage(renderError));
        }
      }
    }, 500);

    return () => window.clearTimeout(timer);
    // saveCurrentDocument updates document summaries, so depending on it would retrigger saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedData, form, activeDocumentId]);

  function loadDataIntoForm(id: string, data: CvData) {
    renderId.current += 1;
    setActiveDocumentId(id);
    saveActiveCvDocumentId(id);
    form.reset(data);
    setSvg(null);
    setStatus("idle");
    setError(null);
  }

  async function selectDocument(id: string) {
    if (id === activeDocumentId) {
      return;
    }

    if (activeDocumentId && !(await saveCurrentDocument({ silent: true }))) {
      return;
    }

    const documentSummary = documents.find((document) => document.id === id);
    if (!documentSummary) {
      setStatus("error");
      setError("The selected CV could not be loaded.");
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

        const document = await loadCloudCvDocument(supabase, id);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, document.data);
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before opening this encrypted CV.");
        }

        if (!hasKnownEncryptionPassphrase(id)) {
          setEncryptionModal({ mode: "unlock", documentId: id });
          setEncryptionPassword("");
          setEncryptionModalError(null);
          return;
        }

        const passphrase = getEncryptionPassphrase(id);
        const document = await loadEncryptedCloudCvDocument(supabase, id);
        const decryptedData = await decryptCvData(document.encryptedPayload, passphrase);
        rememberEncryptionPassphrase(id, passphrase);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, decryptedData);
      }
    } catch (loadError) {
      setStatus("error");
      setError(errorMessage(loadError));
    }
  }

  async function openDocumentWithoutSaving(documentSummary: CvDocumentSummary) {
    try {
      if (documentSummary.storageKind === "local") {
        const document = loadCvDocument(documentSummary.id);
        if (!document) {
          throw new Error("The selected local CV could not be loaded.");
        }

        loadDataIntoForm(document.id, document.data);
      } else if (documentSummary.storageKind === "cloud") {
        if (!supabase || !session) {
          throw new Error("Sign in before opening this cloud CV.");
        }

        const document = await loadCloudCvDocument(supabase, documentSummary.id);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, document.data);
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before opening this encrypted CV.");
        }

        if (!hasKnownEncryptionPassphrase(documentSummary.id)) {
          setEncryptionModal({ mode: "unlock", documentId: documentSummary.id });
          setEncryptionPassword("");
          setEncryptionModalError(null);
          return;
        }

        const passphrase = getEncryptionPassphrase(documentSummary.id);
        const document = await loadEncryptedCloudCvDocument(supabase, documentSummary.id);
        const decryptedData = await decryptCvData(document.encryptedPayload, passphrase);
        rememberEncryptionPassphrase(documentSummary.id, passphrase);
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, decryptedData);
      }
    } catch (loadError) {
      setStatus("error");
      setError(errorMessage(loadError));
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

    const nextTitle = window.prompt("Rename CV", current.title);
    if (!nextTitle) {
      return;
    }

    try {
      if (current.storageKind === "local") {
        setDocuments((existing) => {
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

        const updated = await renameCloudCvDocument(supabase, id, nextTitle);
        upsertDocumentSummary(updated);
      }
    } catch (renameError) {
      setStatus("error");
      setError(errorMessage(renameError));
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

        const source = await loadCloudCvDocument(supabase, id);
        data = source.data;
        title = `${source.title} Copy`;
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before duplicating this encrypted CV.");
        }

        if (!passphraseOverride && !hasKnownEncryptionPassphrase(id)) {
          setEncryptionModal({ mode: "duplicate", documentId: id });
          setEncryptionPassword("");
          setEncryptionModalError(null);
          return;
        }

        const passphrase = passphraseOverride ?? getEncryptionPassphrase(id);
        const source = await loadEncryptedCloudCvDocument(supabase, id);
        data = await decryptCvData(source.encryptedPayload, passphrase);
        title = `${source.title} Copy`;
        rememberEncryptionPassphrase(id, passphrase);
      }

      const document = createLocalCvDocument(data, title);
      replaceLocalDocumentSummary(document);
      loadDataIntoForm(document.id, document.data);
    } catch (duplicateError) {
      setStatus("error");
      setError(errorMessage(duplicateError));
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
        const library = removeCvDocument(id);
        const nextDocuments = documents.filter((document) => document.id !== id);

        if (nextDocuments.length === 0) {
          const document = createLocalCvDocument(createEmptyCvData(), "Untitled CV");
          setDocuments([summarizeLocalDocument(document)]);
          loadDataIntoForm(document.id, document.data);
          return;
        }

        setDocuments(nextDocuments);

        if (id === activeDocumentId) {
          const nextDocumentId =
            library.activeDocumentId && nextDocuments.some((document) => document.id === library.activeDocumentId)
              ? library.activeDocumentId
              : nextDocuments[0]?.id;

          const nextDocument = nextDocuments.find((document) => document.id === nextDocumentId);
          if (nextDocument) {
            await openDocumentWithoutSaving(nextDocument);
          }
        }
      } else if (current.storageKind === "cloud" || current.storageKind === "encrypted") {
        if (!supabase || !session) {
          throw new Error("Sign in before deleting this cloud CV.");
        }

        await deleteCloudCvDocument(supabase, id);
        const nextDocuments = documents.filter((document) => document.id !== id);

        if (nextDocuments.length === 0) {
          const document = createLocalCvDocument(createEmptyCvData(), "Untitled CV");
          setDocuments([summarizeLocalDocument(document)]);
          loadDataIntoForm(document.id, document.data);
          return;
        }

        setDocuments(nextDocuments);

        if (id === activeDocumentId && nextDocuments[0]) {
          await openDocumentWithoutSaving(nextDocuments[0]);
        }
      }
    } catch (deleteError) {
      setStatus("error");
      setError(errorMessage(deleteError));
    }
  }

  function toggleLibraryCollapsed() {
    const nextCollapsed = !libraryCollapsed;
    setLibraryCollapsed(nextCollapsed);
    storeCvLibraryCollapsed(nextCollapsed);
  }

  async function moveToCloud(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    if (!supabase || !session) {
      setStatus("error");
      setError("Sign in before moving a CV to cloud storage.");
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
      setDocuments((currentDocuments) => [
        cloudDocument,
        ...currentDocuments.filter((document) => document.id !== id),
      ]);
      loadDataIntoForm(cloudDocument.id, cloudDocument.data);
      setCloudStatus("ready");
    } catch (moveError) {
      setStatus("error");
      setError(errorMessage(moveError));
    }
  }

  async function enableEncryption(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    if (!supabase || !session) {
      setStatus("error");
      setError("Sign in before enabling encrypted cloud storage.");
      return;
    }

    if (!encryptionPassword) {
      setStatus("error");
      setError("Enter an encryption password before enabling encryption.");
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

      const encryptedPayload = await encryptCvData(sourceData, encryptionPassword);

      if (current.storageKind === "local") {
        const encryptedDocument = await createEncryptedCloudCvDocument(supabase, {
          title: current.title,
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion,
        });
        removeCvDocument(id);
        rememberEncryptionPassphrase(encryptedDocument.id, encryptionPassword);
        setDocuments((currentDocuments) => [
          encryptedDocument,
          ...currentDocuments.filter((document) => document.id !== id),
        ]);
        loadDataIntoForm(encryptedDocument.id, sourceData);
      } else {
        const encryptedDocument = await encryptExistingCloudCvDocument(supabase, id, {
          encryptedPayload,
          schemaVersion: sourceData.schemaVersion,
        });
        rememberEncryptionPassphrase(id, encryptionPassword);
        upsertDocumentSummary(encryptedDocument);
        loadDataIntoForm(id, sourceData);
      }

      setEncryptionPassword("");
      setCloudStatus("ready");
    } catch (encryptionError) {
      setStatus("error");
      setError(errorMessage(encryptionError));
    }
  }

  function closeEncryptionModal() {
    setEncryptionModal(null);
    setEncryptionPassword("");
    setEncryptionModalError(null);
    setTrustEncryptionDevice(false);
  }

  async function unlockEncryptedDocument(id: string) {
    if (!supabase || !session) {
      throw new Error("Sign in before opening this encrypted CV.");
    }

    const document = await loadEncryptedCloudCvDocument(supabase, id);
    const decryptedData = await decryptCvData(document.encryptedPayload, encryptionPassword);
    rememberEncryptionPassphrase(id, encryptionPassword);
    upsertDocumentSummary(document);
    loadDataIntoForm(document.id, decryptedData);
  }

  async function submitEncryptionModal() {
    if (!encryptionModal) {
      return;
    }

    if (!encryptionPassword) {
      setEncryptionModalError("Enter the encryption password first.");
      return;
    }

    try {
      setEncryptionModalError(null);

      if (rememberEncryptionSession) {
        storeRememberEncryptionSession(true);
      }

      if (encryptionModal.mode === "enable") {
        await enableEncryption(encryptionModal.documentId);
      } else if (encryptionModal.mode === "unlock") {
        await unlockEncryptedDocument(encryptionModal.documentId);
      } else if (encryptionModal.mode === "duplicate") {
        await duplicateDocument(encryptionModal.documentId, encryptionPassword);
      } else {
        await exportDocument(encryptionModal.documentId, encryptionPassword);
      }

      closeEncryptionModal();
    } catch (modalError) {
      setEncryptionModalError(errorMessage(modalError));
    }
  }

  function downloadJsonData(data: CvData, title: string) {
    const payload = JSON.stringify(data, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title || "cv-data"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportDocument(id: string, passphraseOverride?: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    try {
      if (id === activeDocumentId) {
        const parsed = cvSchema.safeParse(form.getValues());
        if (!parsed.success) {
          throw new Error("The current form data does not match the CV schema.");
        }

        downloadJsonData(parsed.data, current.title);
        return;
      }

      if (current.storageKind === "local") {
        const document = loadCvDocument(id);
        if (!document) {
          throw new Error("The selected local CV could not be loaded.");
        }

        downloadJsonData(document.data, document.title);
      } else if (current.storageKind === "cloud") {
        if (!supabase || !session) {
          throw new Error("Sign in before exporting this cloud CV.");
        }

        const document = await loadCloudCvDocument(supabase, id);
        downloadJsonData(document.data, document.title);
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before exporting this encrypted CV.");
        }

        if (!passphraseOverride && !hasKnownEncryptionPassphrase(id)) {
          setEncryptionModal({ mode: "export", documentId: id });
          setEncryptionPassword("");
          setEncryptionModalError(null);
          return;
        }

        const document = await loadEncryptedCloudCvDocument(supabase, id);
        const data = await decryptCvData(document.encryptedPayload, passphraseOverride ?? getEncryptionPassphrase(id));
        if (passphraseOverride) {
          rememberEncryptionPassphrase(id, passphraseOverride);
        }
        downloadJsonData(data, document.title);
      }
    } catch (exportError) {
      setStatus("error");
      setError(errorMessage(exportError));
    }
  }

  async function importJson(file: File | undefined) {
    if (!file) {
      return;
    }

    try {
      const parsed = cvSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        setStatus("error");
        setError("Imported JSON does not match schemaVersion 5.");
        return;
      }

      const document = createLocalCvDocument(parsed.data, titleFromImportedData(parsed.data));
      replaceLocalDocumentSummary(document);
      loadDataIntoForm(document.id, document.data);
    } catch (importError) {
      setStatus("error");
      setError(errorMessage(importError));
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  }

  return (
    <FormProvider {...form}>
      <AppShell>
        <Toolbar>
          <ToolbarTitle />
          <ToolbarGroup>
            <Button variant="secondary" size="icon" asChild title="GitHub">
              <a
                href="https://github.com/Yuee98/typst-cv-template"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GithubIcon className="!size-5" />
              </a>
            </Button>
            <div className="relative">
              <Button
                type="button"
                variant={session ? "default" : "secondary"}
                size="icon"
                onClick={() => setAccountMenuOpen((open) => !open)}
                title="Account"
              >
                <UserRound />
              </Button>
              {accountMenuOpen && (
                <div className="absolute right-0 z-30 mt-2 w-64 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
                  {session ? (
                    <div className="space-y-1">
                      <div className="border-b border-slate-200 px-2 pb-2">
                        <div className="truncate text-sm font-medium text-slate-950">{session.user.email}</div>
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                          <Cloud className="size-3.5" />
                          {cloudStatus === "loading" ? "Syncing" : "Cloud ready"}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                        onClick={() => void refreshCloudDocuments()}
                      >
                        <Cloud className="size-4" />
                        Sync cloud
                      </button>
                      <button
                        type="button"
                        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                        onClick={() => void signOut()}
                      >
                        <LogOut className="size-4" />
                        Log out
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="border-b border-slate-200 px-2 pb-2 text-xs text-slate-500">
                        {supabaseConfigured ? "Cloud signed out" : "Cloud not configured"}
                      </div>
                      <button
                        type="button"
                        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={!supabaseConfigured}
                        onClick={() => {
                          setAuthModalMode("signIn");
                          setAccountMenuOpen(false);
                        }}
                      >
                        <LogIn className="size-4" />
                        Log in
                      </button>
                      <button
                        type="button"
                        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={!supabaseConfigured}
                        onClick={() => {
                          setAuthModalMode("signUp");
                          setAccountMenuOpen(false);
                        }}
                      >
                        <UserPlus className="size-4" />
                        Sign up
                      </button>
                      <button
                        type="button"
                        className="flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={!supabaseConfigured}
                        onClick={() => void signInWithGithub()}
                      >
                        <GithubIcon className="!size-4" />
                        GitHub SSO
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void importJson(event.target.files?.[0])}
            />
          </ToolbarGroup>
        </Toolbar>
        <Workspace
          library={
            <CvLibrarySidebar
              documents={documents}
              activeDocumentId={activeDocumentId}
              collapsed={libraryCollapsed}
              cloudActionsEnabled={cloudActionsEnabled}
              onToggleCollapsed={toggleLibraryCollapsed}
              onCreateEmpty={() => void createEmptyDocument()}
              onCreateSample={() => void createSampleDocument()}
              onImportJson={() => importInputRef.current?.click()}
              onSelect={(id) => void selectDocument(id)}
              onRename={(id) => void renameDocument(id)}
              onDuplicate={(id) => void duplicateDocument(id)}
              onExport={(id) => void exportDocument(id)}
              onDelete={(id) => void deleteDocument(id)}
              onMoveToCloud={(id) => void moveToCloud(id)}
              onEnableEncryption={(id) => {
                setEncryptionModal({ mode: "enable", documentId: id });
                setEncryptionPassword("");
                setEncryptionModalError(null);
              }}
            />
          }
          editor={
            <CvEditor
              actions={
                <Button type="button" variant="secondary" size="icon" onClick={() => void saveCurrentDocument()} title="Save">
                  <Save />
                </Button>
              }
            />
          }
          preview={
            <PreviewPane
              svg={svg}
              status={status}
              error={error}
              actions={
                <Button type="button" variant="secondary" size="icon" onClick={() => window.print()} title="Print">
                  <Printer />
                </Button>
              }
            />
          }
        />
        {authModalMode && (
          <Modal
            title={authModalMode === "signIn" ? "Log in" : "Sign up"}
            onClose={() => setAuthModalMode(null)}
            footer={
              <>
                <Button type="button" variant="secondary" onClick={() => setAuthModalMode(null)}>
                  Cancel
                </Button>
                <Button type="button" onClick={() => void (authModalMode === "signIn" ? signIn() : signUp())}>
                  {authModalMode === "signIn" ? "Log in" : "Sign up"}
                </Button>
              </>
            }
          >
            <div className="space-y-3">
              <Input
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder="email"
              />
              <Input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                placeholder="password"
              />
              <Button type="button" variant="secondary" className="w-full" onClick={() => void signInWithGithub()}>
                <GithubIcon className="!size-4" />
                GitHub SSO
              </Button>
            </div>
          </Modal>
        )}
        {encryptionModal && (
          <Modal
            title={
              encryptionModal.mode === "enable"
                ? "Enable encryption"
                : encryptionModal.mode === "unlock"
                  ? "Unlock encrypted CV"
                  : encryptionModal.mode === "duplicate"
                    ? "Duplicate encrypted CV"
                    : "Export encrypted CV"
            }
            onClose={closeEncryptionModal}
            footer={
              <>
                <Button type="button" variant="secondary" onClick={closeEncryptionModal}>
                  Cancel
                </Button>
                <Button type="button" onClick={() => void submitEncryptionModal()}>
                  <ShieldCheck />
                  Continue
                </Button>
              </>
            }
          >
            <div className="space-y-3">
              <Input
                type="password"
                value={encryptionPassword}
                onChange={(event) => {
                  setEncryptionPassword(event.target.value);
                  setEncryptionModalError(null);
                }}
                placeholder="encryption password"
              />
              {encryptionModalError && (
                <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {encryptionModalError}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={rememberEncryptionSession}
                    onChange={(event) => {
                      setRememberEncryptionSession(event.target.checked);
                      storeRememberEncryptionSession(event.target.checked);
                      if (!event.target.checked) {
                        clearSessionEncryptionPasswords();
                      }
                    }}
                    className="size-3.5 accent-emerald-600"
                  />
                  Remember until refresh
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={trustEncryptionDevice}
                    onChange={(event) => setTrustEncryptionDevice(event.target.checked)}
                    className="size-3.5 accent-emerald-600"
                  />
                  Trust this device
                </label>
              </div>
            </div>
          </Modal>
        )}
      </AppShell>
    </FormProvider>
  );
}
