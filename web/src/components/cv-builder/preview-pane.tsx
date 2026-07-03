"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import { splitTypstSvg } from "@/lib/typst/typst-svg-utils";

export type PreviewStatus = "idle" | "rendering" | "ready" | "error";

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
  actions,
}: {
  svg: string | null;
  status: PreviewStatus;
  error: string | null;
  actions?: ReactNode;
}) {
  const pages = useMemo(() => splitTypstSvg(svg ?? ""), [svg]);

  return (
    <Panel
      title="Preview"
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          {actions}
        </div>
      }
      className="preview-pane flex h-full min-h-[720px] flex-col overflow-hidden"
    >
      {error && (
        <div className="preview-error border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800 print:hidden">
          {error}
        </div>
      )}
      <div className="preview-scroll flex-1 overflow-auto bg-slate-200 p-5">
        <div className="mx-auto flex w-full max-w-[210mm] flex-col gap-5">
          {pages.length > 0 ? (
            pages.map((page, index) => (
              <div
                key={index}
                className="typst-page-shell bg-white shadow-md ring-1 ring-slate-300"
                dangerouslySetInnerHTML={{ __html: page }}
              />
            ))
          ) : (
            <div className="flex aspect-[210/297] w-full items-center justify-center bg-white text-sm text-slate-500 shadow-md ring-1 ring-slate-300">
              Preview will appear here.
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
