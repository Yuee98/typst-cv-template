"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Download, Printer, RefreshCcw, Save, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarTitle } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { CvEditor } from "@/components/cv-builder/editors";
import { CvLibrarySidebar } from "@/components/cv-builder/cv-library-sidebar";
import { PreviewPane, type PreviewStatus } from "@/components/cv-builder/preview-pane";
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
import { renderTypstSvg } from "@/lib/typst/render";

type SaveStatus = "idle" | "saving" | "saved" | "error";

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
  const importInputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) {
        return;
      }

      const library = initializeCvDocumentLibrary(cloneCvData(sampleCvData));
      const initialDocument = library.activeDocumentId ? loadCvDocument(library.activeDocumentId) : null;
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

  function replaceDocumentSummary(document: LocalCvDocument) {
    const summary = summarizeLocalDocument(document);
    setDocuments((current) =>
      current.some((item) => item.id === summary.id)
        ? current.map((item) => (item.id === summary.id ? summary : item))
        : [summary, ...current],
    );
  }

  function saveCurrentDocument({ silent = false }: { silent?: boolean } = {}) {
    if (!activeDocumentId) {
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

    const updated = updateLocalCvDocumentData(activeDocumentId, parsed.data);
    if (!updated) {
      setSaveStatus("error");
      setStatus("error");
      setError("The active CV could not be saved.");
      return false;
    }

    replaceDocumentSummary(updated);
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

      const updated = updateLocalCvDocumentData(activeDocumentId, parsed.data);
      if (updated) {
        replaceDocumentSummary(updated);
        setSaveStatus("saved");
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
  }, [watchedData, form, activeDocumentId]);

  function loadDocumentIntoForm(document: LocalCvDocument) {
    renderId.current += 1;
    setActiveDocumentId(document.id);
    saveActiveCvDocumentId(document.id);
    form.reset(document.data);
    setSvg(null);
    setStatus("idle");
    setError(null);
    setSaveStatus("saved");
  }

  function selectDocument(id: string) {
    if (id === activeDocumentId) {
      return;
    }

    if (!saveCurrentDocument({ silent: true })) {
      return;
    }

    const document = loadCvDocument(id);
    if (!document) {
      setStatus("error");
      setError("The selected CV could not be loaded.");
      return;
    }

    loadDocumentIntoForm(document);
  }

  function createDocument() {
    if (activeDocumentId) {
      saveCurrentDocument({ silent: true });
    }

    const document = createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
    replaceDocumentSummary(document);
    loadDocumentIntoForm(document);
  }

  function renameDocument(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    const nextTitle = window.prompt("Rename CV", current.title);
    if (!nextTitle) {
      return;
    }

    setDocuments(renameCvDocument(id, nextTitle));
  }

  function duplicateDocument(id: string) {
    const document = duplicateCvDocument(id);
    if (!document) {
      setStatus("error");
      setError("The selected CV could not be duplicated.");
      return;
    }

    replaceDocumentSummary(document);
    loadDocumentIntoForm(document);
  }

  function deleteDocument(id: string) {
    const current = documents.find((document) => document.id === id);
    if (!current) {
      return;
    }

    if (!window.confirm(`Delete "${current.title}"?`)) {
      return;
    }

    const library = removeCvDocument(id);
    if (library.documents.length === 0) {
      const document = createLocalCvDocument(cloneCvData(sampleCvData), "Untitled CV");
      setDocuments([summarizeLocalDocument(document)]);
      loadDocumentIntoForm(document);
      return;
    }

    setDocuments(library.documents);

    if (id === activeDocumentId && library.activeDocumentId) {
      const nextDocument = loadCvDocument(library.activeDocumentId);
      if (nextDocument) {
        loadDocumentIntoForm(nextDocument);
      }
    }
  }

  function toggleLibraryCollapsed() {
    const nextCollapsed = !libraryCollapsed;
    setLibraryCollapsed(nextCollapsed);
    storeCvLibraryCollapsed(nextCollapsed);
  }

  function showCloudScaffoldMessage() {
    setStatus("error");
    setError("Cloud storage is scaffolded in the database layer. Supabase sign-in and sync are the next implementation step.");
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
      replaceDocumentSummary(document);
      loadDocumentIntoForm(document);
    } catch (importError) {
      setStatus("error");
      setError(errorMessage(importError));
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = "";
      }
    }
  }

  function resetToSample() {
    const sample = cloneCvData(sampleCvData);
    form.reset(sample);
    if (activeDocumentId) {
      const updated = updateLocalCvDocumentData(activeDocumentId, sample);
      if (updated) {
        replaceDocumentSummary(updated);
      }
    }
    setError(null);
    setSaveStatus("saved");
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
            <Button type="button" onClick={() => saveCurrentDocument()}>
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
            <Button type="button" variant="ghost" onClick={resetToSample}>
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
              cloudActionsEnabled={false}
              onToggleCollapsed={toggleLibraryCollapsed}
              onCreate={createDocument}
              onSelect={selectDocument}
              onRename={renameDocument}
              onDuplicate={duplicateDocument}
              onDelete={deleteDocument}
              onMoveToCloud={showCloudScaffoldMessage}
              onEnableEncryption={showCloudScaffoldMessage}
            />
          }
          editor={<CvEditor />}
          preview={<PreviewPane svg={svg} status={status} error={error} />}
        />
      </AppShell>
    </FormProvider>
  );
}
