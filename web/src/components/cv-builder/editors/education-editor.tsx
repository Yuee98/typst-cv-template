"use client";

import { Plus, Trash2 } from "lucide-react";
import { useFormContext } from "react-hook-form";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Field, FieldGrid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { CvData } from "@/lib/cv/schema";

import { BulletEditor } from "./text-items-editor";
import { fieldPath, resumeEntryItem, useCvFieldArray, WatchedTitle } from "./shared";

export function ResumeEntriesEditor({
  name,
  addLabel,
}: {
  name: string;
  addLabel: string;
}) {
  const { register } = useFormContext<CvData>();
  const { fields, append, remove } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <Accordion type="multiple" className="rounded-md border border-slate-200 px-3">
        {fields.map((field, index) => (
          <AccordionItem key={field.id} value={field.id}>
            <AccordionTrigger>
              <WatchedTitle name={`${name}.${index}.org`} fallback={`Entry ${index + 1}`} />
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3">
                <FieldGrid>
                  <Field label="Organization">
                    <Input {...register(fieldPath(`${name}.${index}.org`))} />
                  </Field>
                  <Field label="Date">
                    <Input {...register(fieldPath(`${name}.${index}.date`))} />
                  </Field>
                  <Field label="Title">
                    <Input {...register(fieldPath(`${name}.${index}.title`))} />
                  </Field>
                  <Field label="Detail">
                    <Input {...register(fieldPath(`${name}.${index}.detail`))} />
                  </Field>
                </FieldGrid>
                <BulletEditor name={`${name}.${index}.bullets`} />
                <Button type="button" variant="destructive" size="sm" onClick={() => remove(index)}>
                  <Trash2 />
                  Remove education
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      <Button type="button" variant="secondary" onClick={() => append(resumeEntryItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}
