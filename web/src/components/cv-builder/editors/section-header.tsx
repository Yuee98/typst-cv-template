"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useFormContext } from "react-hook-form";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CvData } from "@/lib/cv/schema";
import { cn } from "@/lib/utils";

import { fieldPath } from "./shared";

export function SectionHeader({ name, actions }: { name: string; actions?: ReactNode }) {
  const { register } = useFormContext<CvData>();
  const t = useTranslations("Editors");
  const basePath = `sectionTitles.${name}` as const;

  return (
    <div
      className={cn(
        "grid gap-3 sm:items-end",
        actions
          ? "sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
          : "sm:grid-cols-[minmax(0,1fr)_auto_auto]",
      )}
    >
      <Field label={t("Shared.sectionTitle")}>
        <Input {...register(fieldPath(`${basePath}.title`))} />
      </Field>
      <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-sm text-foreground-muted">
        <input
          type="checkbox"
          {...register(fieldPath(`${basePath}.isDisplay`))}
          className="accent-accent"
        />
        {t("Shared.show")}
      </label>
      <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-sm text-foreground-muted">
        <input
          type="checkbox"
          {...register(fieldPath(`${basePath}.pageBreakBefore`))}
          className="accent-accent"
        />
        {t("Shared.startOnNewPage")}
      </label>
      {actions && <div className="flex h-9 items-center gap-1">{actions}</div>}
    </div>
  );
}

export function SelfNameField() {
  const { register } = useFormContext<CvData>();
  const t = useTranslations("Editors");

  return (
    <div className="max-w-1/2">
      <Field label={t("Publications.selfNameLabel")}>
        <Input
          placeholder={t("Publications.selfNamePlaceholder")}
          {...register(fieldPath("header.selfName"))}
        />
      </Field>
    </div>
  );
}
