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
    <div className="space-y-1.5">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Section</div>
      <div className="grid grid-cols-2 items-center gap-3">
        <Input {...register(fieldPath(`${basePath}.title`))} />
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            {...register(fieldPath(`${basePath}.isDisplay`))}
            className="accent-slate-900"
          />
          Show in preview
        </label>
      </div>
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
