"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  Cloud,
  Download,
  LogIn,
  LogOut,
  Printer,
  RefreshCcw,
  Save,
  Upload,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarTitle } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { Input } from "@/components/ui/input";
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
  duplicateCvDocument,
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

type SaveStatus = "idle" | "saving" | "saved" | "error";
type CloudStatus = "idle" | "loading" | "ready" | "error";

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

export function CvBuilder() {
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<CvDocumentSummary[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [supabase] = useState(() => getSupabaseBrowserClient());
  const [session, setSession] = useState<Session | null>(null);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("idle");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [encryptionPassword, setEncryptionPassword] = useState("");
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
        setDocuments([]);
        setActiveDocumentId(null);
        saveActiveCvDocumentId(null);
        setLibraryCollapsed(loadCvLibraryCollapsed());
        form.reset(cloneCvData(sampleCvData));
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

    const localDocuments = documents.filter((document) => document.storageKind === "local");
    if (activeDocument?.storageKind === "cloud" || localDocuments.length === 0) {
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
      setSaveStatus("error");
      setStatus("error");
      setError("The current form data does not match the CV schema.");
      return false;
    }

    if (!silent) {
      setSaveStatus("saving");
    }

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

        const passphrase = encryptedPasswordsRef.current[activeDocumentId] ?? encryptionPassword;
        const encryptedPayload = await encryptCvData(parsed.data, passphrase);
        const updated = await updateEncryptedCloudCvDocumentData(supabase, activeDocumentId, {
          encryptedPayload,
          schemaVersion: parsed.data.schemaVersion,
        });
        encryptedPasswordsRef.current[activeDocumentId] = passphrase;
        upsertDocumentSummary(updated);
      }
    } catch (saveError) {
      setSaveStatus("error");
      setStatus("error");
      setError(errorMessage(saveError));
      return false;
    }

    setSaveStatus("saved");
    return true;
  }

  useEffect(() => {
    if (!initializedRef.current || !activeDocumentId) {
      return;
    }

    const timer = window.setTimeout(async () => {
      const parsed = cvSchema.safeParse(form.getValues());
      if (!parsed.success) {
        setSaveStatus("error");
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
    setSaveStatus("saved");
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

        const passphrase = encryptedPasswordsRef.current[id] ?? encryptionPassword;
        const document = await loadEncryptedCloudCvDocument(supabase, id);
        const decryptedData = await decryptCvData(document.encryptedPayload, passphrase);
        encryptedPasswordsRef.current[id] = passphrase;
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

        const passphrase = encryptedPasswordsRef.current[documentSummary.id] ?? encryptionPassword;
        const document = await loadEncryptedCloudCvDocument(supabase, documentSummary.id);
        const decryptedData = await decryptCvData(document.encryptedPayload, passphrase);
        encryptedPasswordsRef.current[documentSummary.id] = passphrase;
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, decryptedData);
      }
    } catch (loadError) {
      setStatus("error");
      setError(errorMessage(loadError));
    }
  }

  async function createDocument() {
    if (activeDocumentId) {
      await saveCurrentDocument({ silent: true });
    }

    const document = createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
    replaceLocalDocumentSummary(document);
    loadDataIntoForm(document.id, document.data);
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

  async function duplicateDocument(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) return;

    try {
      if (current.storageKind === "local") {
        const document = duplicateCvDocument(id);
        if (!document) {
          throw new Error("The selected CV could not be duplicated.");
        }

        replaceLocalDocumentSummary(document);
        loadDataIntoForm(document.id, document.data);
      } else if (current.storageKind === "cloud") {
        if (!supabase || !session) {
          throw new Error("Sign in before duplicating this cloud CV.");
        }

        const source = await loadCloudCvDocument(supabase, id);
        const document = await createCloudCvDocument(supabase, {
          title: `${source.title} Copy`,
          data: source.data,
        });
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, document.data);
      } else {
        if (!supabase || !session) {
          throw new Error("Sign in before duplicating this encrypted CV.");
        }

        const passphrase = encryptedPasswordsRef.current[id] ?? encryptionPassword;
        const source = await loadEncryptedCloudCvDocument(supabase, id);
        const decryptedData = await decryptCvData(source.encryptedPayload, passphrase);
        const encryptedPayload = await encryptCvData(decryptedData, passphrase);
        const document = await createEncryptedCloudCvDocument(supabase, {
          title: `${source.title} Copy`,
          encryptedPayload,
          schemaVersion: decryptedData.schemaVersion,
        });
        encryptedPasswordsRef.current[document.id] = passphrase;
        upsertDocumentSummary(document);
        loadDataIntoForm(document.id, decryptedData);
      }
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
          const document = createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
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
          const document = createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
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
        encryptedPasswordsRef.current[encryptedDocument.id] = encryptionPassword;
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
        encryptedPasswordsRef.current[id] = encryptionPassword;
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

  function exportJson() {
    const parsed = cvSchema.safeParse(form.getValues());
    const payload = JSON.stringify(parsed.success ? parsed.data : form.getValues(), null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeDocument?.title ?? "cv-data"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
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

  async function resetToSample() {
    const sample = cloneCvData(sampleCvData);
    form.reset(sample);
    try {
      if (activeDocumentId && activeDocument?.storageKind === "local") {
        const updated = updateLocalCvDocumentData(activeDocumentId, sample);
        if (updated) {
          replaceLocalDocumentSummary(updated);
        }
      } else if (activeDocumentId && activeDocument?.storageKind === "cloud" && supabase && session) {
        const updated = await updateCloudCvDocumentData(supabase, activeDocumentId, sample);
        upsertDocumentSummary(updated);
      } else if (activeDocumentId && activeDocument?.storageKind === "encrypted" && supabase && session) {
        const passphrase = encryptedPasswordsRef.current[activeDocumentId] ?? encryptionPassword;
        const encryptedPayload = await encryptCvData(sample, passphrase);
        const updated = await updateEncryptedCloudCvDocumentData(supabase, activeDocumentId, {
          encryptedPayload,
          schemaVersion: sample.schemaVersion,
        });
        encryptedPasswordsRef.current[activeDocumentId] = passphrase;
        upsertDocumentSummary(updated);
      }
      setError(null);
      setSaveStatus("saved");
    } catch (resetError) {
      setSaveStatus("error");
      setStatus("error");
      setError(errorMessage(resetError));
    }
  }

  return (
    <FormProvider {...form}>
      <AppShell>
        <Toolbar>
          <ToolbarTitle />
          <ToolbarGroup>
            <Button variant="secondary" asChild>
              <a
                href="https://github.com/Yuee98/typst-cv-template"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GithubIcon className="!size-5" />
                GitHub
              </a>
            </Button>
            <ToolbarSeparator />
            {supabaseConfigured &&
              (session ? (
                <>
                  <Button type="button" variant="secondary" onClick={() => void refreshCloudDocuments()}>
                    <Cloud />
                    {cloudStatus === "loading" ? "Syncing" : "Cloud"}
                  </Button>
                  <span className="hidden max-w-44 truncate text-xs font-medium text-slate-500 lg:inline">
                    {session.user.email}
                  </span>
                  <Input
                    type="password"
                    value={encryptionPassword}
                    onChange={(event) => setEncryptionPassword(event.target.value)}
                    placeholder="encryption password"
                    className="w-48"
                  />
                  <Button type="button" variant="ghost" onClick={() => void signOut()}>
                    <LogOut />
                    Sign out
                  </Button>
                </>
              ) : (
                <>
                  <Input
                    type="email"
                    value={authEmail}
                    onChange={(event) => setAuthEmail(event.target.value)}
                    placeholder="email"
                    className="w-44"
                  />
                  <Input
                    type="password"
                    value={authPassword}
                    onChange={(event) => setAuthPassword(event.target.value)}
                    placeholder="password"
                    className="w-36"
                  />
                  <Button type="button" variant="secondary" onClick={() => void signIn()}>
                    <LogIn />
                    Sign in
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => void signUp()}>
                    <UserPlus />
                    Create
                  </Button>
                </>
              ))}
            {supabaseConfigured && <ToolbarSeparator />}
            <Button type="button" onClick={() => void saveCurrentDocument()}>
              <Save />
              Save
            </Button>
            <span className="hidden text-xs font-medium text-slate-500 sm:inline">
              {saveStatus === "saving" && "Saving"}
              {saveStatus === "saved" && "Saved"}
              {saveStatus === "error" && "Save error"}
            </span>
            <ToolbarSeparator />
            <Button type="button" variant="secondary" onClick={exportJson}>
              <Download />
              Export JSON
            </Button>
            <Button type="button" variant="secondary" onClick={() => importInputRef.current?.click()}>
              <Upload />
              Import JSON
            </Button>
            <ToolbarSeparator />
            <Button type="button" variant="ghost" onClick={() => void resetToSample()}>
              <RefreshCcw />
              Reset sample
            </Button>
            <ToolbarSeparator />
            <Button type="button" onClick={() => window.print()}>
              <Printer />
              Print
            </Button>
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
              onCreate={() => void createDocument()}
              onSelect={(id) => void selectDocument(id)}
              onRename={(id) => void renameDocument(id)}
              onDuplicate={(id) => void duplicateDocument(id)}
              onDelete={(id) => void deleteDocument(id)}
              onMoveToCloud={(id) => void moveToCloud(id)}
              onEnableEncryption={(id) => void enableEncryption(id)}
            />
          }
          editor={<CvEditor />}
          preview={<PreviewPane svg={svg} status={status} error={error} />}
        />
      </AppShell>
    </FormProvider>
  );
}
