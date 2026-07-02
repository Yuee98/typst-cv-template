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

import { fieldPath, publicationItem, useCvFieldArray, WatchedTitle } from "./shared";

export function PublicationsEditor({ name }: { name: string }) {
  const { register } = useFormContext<CvData>();
  const { fields, append, remove } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <Accordion type="multiple" className="rounded-md border border-slate-200 px-3">
        {fields.map((field, index) => (
          <AccordionItem key={field.id} value={field.id}>
            <AccordionTrigger>
              <WatchedTitle
                name={`${name}.${index}.title`}
                fallback={`Publication ${index + 1}`}
              />
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-3">
                <Field label="Authors">
                  <Input
                    placeholder="Ming Chen, John Doe, Jane Smith"
                    {...register(fieldPath(`${name}.${index}.authors`))}
                  />
                </Field>
                <Field label="Title">
                  <Input {...register(fieldPath(`${name}.${index}.title`))} />
                </Field>
                <FieldGrid>
                  <Field label="Venue">
                    <Input
                      placeholder="IEEE ICWS"
                      {...register(fieldPath(`${name}.${index}.venue`))}
                    />
                  </Field>
                  <Field label="Year">
                    <Input {...register(fieldPath(`${name}.${index}.year`))} />
                  </Field>
                </FieldGrid>
                <Field label="URL">
                  <Input
                    placeholder="https://doi.org/..."
                    {...register(fieldPath(`${name}.${index}.url`))}
                  />
                </Field>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => remove(index)}
                >
                  <Trash2 />
                  Remove publication
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      <Button type="button" variant="secondary" onClick={() => append(publicationItem() as never)}>
        <Plus />
        Add publication
      </Button>
    </div>
  );
}
