"use client";

import { useFormContext } from "react-hook-form";

import { Field, FieldGrid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CvData } from "@/lib/cv/schema";

import { fieldPath } from "./shared";

export function HeaderEditor() {
  const { register } = useFormContext<CvData>();
  const base = "header";

  return (
    <div className="grid gap-4">
      <FieldGrid>
        <Field label="Name">
          <Input {...register(fieldPath(`${base}.name`))} />
        </Field>
        <Field label="Subtitle">
          <Input {...register(fieldPath(`${base}.subtitle`))} />
        </Field>
        <Field label="Email">
          <Input {...register(fieldPath(`${base}.email`))} />
        </Field>
        <Field label="Phone">
          <Input {...register(fieldPath(`${base}.phone`))} />
        </Field>
      </FieldGrid>
    </div>
  );
}
