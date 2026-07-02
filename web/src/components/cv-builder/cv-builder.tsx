"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Download, Printer, RefreshCcw, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";

import { AppShell, Workspace } from "@/components/layout/app-shell";
import { Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarTitle } from "@/components/layout/toolbar";
import { Button } from "@/components/ui/button";
import { GithubIcon } from "@/components/ui/github-icon";
import { CvEditor } from "@/components/cv-builder/editors";
import { PreviewPane, type PreviewStatus } from "@/components/cv-builder/preview-pane";
import { buildTypstDocument } from "@/lib/cv/typst";
import { cvSchema, type CvData } from "@/lib/cv/schema";
import { sampleCvData } from "@/lib/cv/sample-data";
import { clearStoredCvData, loadStoredCvData, storeCvData } from "@/lib/cv/storage";
import { renderTypstSvg } from "@/lib/typst/render";

function cloneCvData(data: CvData): CvData {
  return JSON.parse(JSON.stringify(data)) as CvData;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function CvBuilder() {
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const renderId = useRef(0);

  const form = useForm<CvData>({
    resolver: zodResolver(cvSchema),
    defaultValues: cloneCvData(sampleCvData),
    mode: "onChange",
  });

  const watchedData = useWatch({ control: form.control });

  useEffect(() => {
    const stored = loadStoredCvData();
    if (stored) {
      form.reset(stored);
    }
  }, [form]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const parsed = cvSchema.safeParse(form.getValues());
      if (!parsed.success) {
        setStatus("error");
        setError("The current form data does not match the CV schema.");
        return;
      }

      storeCvData(parsed.data);
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
  }, [watchedData, form]);

  function exportJson() {
    const parsed = cvSchema.safeParse(form.getValues());
    const payload = JSON.stringify(parsed.success ? parsed.data : form.getValues(), null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "cv-data.json";
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
        setError("Imported JSON does not match schemaVersion 3.");
        return;
      }

      form.reset(parsed.data);
      storeCvData(parsed.data);
      setError(null);
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
    storeCvData(sample);
    setError(null);
  }

  function clearLocalData() {
    clearStoredCvData();
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
            <Button type="button" variant="destructive" onClick={clearLocalData}>
              <Trash2 />
              Clear local
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
          editor={<CvEditor />}
          preview={<PreviewPane svg={svg} status={status} error={error} />}
        />
      </AppShell>
    </FormProvider>
  );
}
