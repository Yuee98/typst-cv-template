"use client";

import { useFormContext } from "react-hook-form";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CvData } from "@/lib/cv/schema";

import { fieldPath } from "./shared";

export function SectionHeader({ name }: { name: string }) {
  const { register } = useFormContext<CvData>();
  const basePath = `sectionTitles.${name}` as const;

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
      <Field label="Section title">
        <Input {...register(fieldPath(`${basePath}.title`))} />
      </Field>
      <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-sm text-slate-700">
        <input
          type="checkbox"
          {...register(fieldPath(`${basePath}.isDisplay`))}
          className="accent-slate-900"
        />
        Show
      </label>
      <label className="flex h-9 items-center gap-1.5 whitespace-nowrap text-sm text-slate-700">
        <input
          type="checkbox"
          {...register(fieldPath(`${basePath}.pageBreakBefore`))}
          className="accent-slate-900"
        />
        Start on new page
      </label>
    </div>
  );
}

export function SelfNameField() {
  const { register } = useFormContext<CvData>();

  return (
    <div className="max-w-1/2">
      <Field label="Author name in publications">
        <Input
          placeholder="e.g. Ming Chen, Chen M"
          {...register(fieldPath("header.selfName"))}
        />
      </Field>
    </div>
  );
}
