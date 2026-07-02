"use client";

import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

export type PreviewStatus = "idle" | "rendering" | "ready" | "error";

function splitTypstSvg(svg: string) {
  if (typeof window === "undefined") {
    return svg ? [svg] : [];
  }

  const template = document.createElement("template");
  template.innerHTML = svg.trim();
  const root = template.content.querySelector("svg");
  const pages = Array.from(root?.querySelectorAll("g.typst-page") ?? []);

  if (!root || pages.length === 0) {
    return svg ? [svg] : [];
  }

  const shared = Array.from(root.children)
    .filter((child) => {
      const name = child.localName.toLowerCase();
      return name === "style" || name === "defs";
    })
    .map((child) => child.outerHTML)
    .join("");

  return pages.map((page) => {
    const width = page.getAttribute("data-page-width") ?? "612";
    const height = page.getAttribute("data-page-height") ?? "792";
    const clone = page.cloneNode(true) as Element;
    clone.setAttribute("transform", "translate(0, 0)");
    return `<svg style="overflow: visible;" class="typst-doc" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" data-width="${width}" data-height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:h5="http://www.w3.org/1999/xhtml">${shared}${clone.outerHTML}</svg>`;
  });
}

function StatusBadge({ status }: { status: PreviewStatus }) {
  const label = {
    idle: "Waiting",
    rendering: "Rendering",
    ready: "Ready",
    error: "Error",
  }[status];

  const Icon = status === "rendering" ? Loader2 : status === "error" ? AlertTriangle : CheckCircle2;

  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium",
        status === "error"
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-emerald-200 bg-emerald-50 text-emerald-700",
      )}
    >
      <Icon className={cn("size-4", status === "rendering" && "animate-spin")} />
      {label}
    </span>
  );
}

export function PreviewPane({
  svg,
  status,
  error,
}: {
  svg: string | null;
  status: PreviewStatus;
  error: string | null;
}) {
  const pages = useMemo(() => splitTypstSvg(svg ?? ""), [svg]);

  return (
    <Panel
      title="Preview"
      actions={<StatusBadge status={status} />}
      className="preview-pane flex h-full min-h-[720px] flex-col overflow-hidden"
    >
      {error && (
        <div className="preview-error border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800 print:hidden">
          {error}
        </div>
      )}
      <div className="preview-scroll flex-1 overflow-auto bg-slate-200 p-5">
        <div className="mx-auto flex w-full max-w-[8.5in] flex-col gap-5">
          {pages.length > 0 ? (
            pages.map((page, index) => (
              <div
                key={index}
                className="typst-page-shell bg-white shadow-md ring-1 ring-slate-300"
                dangerouslySetInnerHTML={{ __html: page }}
              />
            ))
          ) : (
            <div className="flex h-[11in] w-[8.5in] items-center justify-center bg-white text-sm text-slate-500 shadow-md ring-1 ring-slate-300">
              Preview will appear here.
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
