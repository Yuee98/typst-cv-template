"use client";

import { useTranslations } from "next-intl";
import { useFormContext } from "react-hook-form";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CvData } from "@/lib/cv/schema";

import { fieldPath } from "./shared";

export function SectionHeader({ name }: { name: string }) {
  const { register } = useFormContext<CvData>();
  const t = useTranslations("Editors");
  const basePath = `sectionTitles.${name}` as const;

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
      <Field label={t("Shared.sectionTitle")}>
        <Input {...register(fieldPath(`${basePath}.title`))} />
      </Field>
      <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-sm text-slate-700">
        <input
          type="checkbox"
          {...register(fieldPath(`${basePath}.isDisplay`))}
          className="accent-slate-900"
        />
        {t("Shared.show")}
      </label>
      <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-sm text-slate-700">
        <input
          type="checkbox"
          {...register(fieldPath(`${basePath}.pageBreakBefore`))}
          className="accent-slate-900"
        />
        {t("Shared.startOnNewPage")}
      </label>
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
