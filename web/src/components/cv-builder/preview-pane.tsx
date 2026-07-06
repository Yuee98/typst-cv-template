"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import type { LoadStage } from "@/lib/typst/render";
import { splitTypstSvg } from "@/lib/typst/typst-svg-utils";

export type PreviewStatus = LoadStage;

function StatusBadge({ status, label, percent }: { status: PreviewStatus; label: string; percent: number | null }) {
  const isActive = status === "loading-assets" || status === "compiling";
  const Icon = isActive ? Loader2 : status === "error" ? AlertTriangle : CheckCircle2;

  return (
    <span
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium",
        status === "error"
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-emerald-200 bg-emerald-50 text-emerald-700",
      )}
    >
      <Icon className={cn("size-4", isActive && "animate-spin")} />
      {label}
      {percent != null && (
        <span className="inline-flex w-20 items-center gap-1.5">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-emerald-200">
            <span
              className="block h-full rounded-full bg-emerald-500 transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="tabular-nums">{percent}%</span>
        </span>
      )}
    </span>
  );
}

export function PreviewPane({
  svg,
  status,
  percent,
  error,
  actions,
}: {
  svg: string | null;
  status: PreviewStatus;
  percent: number | null;
  error: string | null;
  actions?: ReactNode;
}) {
  const t = useTranslations("PreviewPane");
  const statusLabels: Record<LoadStage, string> = {
    idle: t("status.waiting"),
    "loading-assets": t("status.loadingAssets"),
    compiling: t("status.compiling"),
    ready: t("status.ready"),
    error: t("status.error"),
  };
  const pages = useMemo(() => splitTypstSvg(svg ?? ""), [svg]);

  return (
    <Panel
      title={t("title")}
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge status={status} label={statusLabels[status]} percent={percent} />
          {actions}
        </div>
      }
      className="preview-pane flex h-full flex-col overflow-hidden"
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
              {t("emptyHint")}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
