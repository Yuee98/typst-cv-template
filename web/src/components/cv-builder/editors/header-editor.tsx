"use client";

import { useTranslations } from "next-intl";
import { useFormContext } from "react-hook-form";

import { Field, FieldGrid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CvData } from "@/lib/cv/schema";

import { fieldPath } from "./shared";

export function HeaderEditor() {
  const { register } = useFormContext<CvData>();
  const t = useTranslations("Editors.Header");
  const base = "header";

  return (
    <div className="grid gap-4">
      <FieldGrid>
        <Field label={t("name")}>
          <Input {...register(fieldPath(`${base}.name`))} />
        </Field>
        <Field label={t("subtitle")}>
          <Input {...register(fieldPath(`${base}.subtitle`))} />
        </Field>
        <Field label={t("email")}>
          <Input {...register(fieldPath(`${base}.email`))} />
        </Field>
        <Field label={t("phone")}>
          <Input {...register(fieldPath(`${base}.phone`))} />
        </Field>
      </FieldGrid>
    </div>
  );
}
