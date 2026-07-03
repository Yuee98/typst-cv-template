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
import { SortableList } from "@/components/ui/sortable-list";
import type { CvData } from "@/lib/cv/schema";

import { fieldPath, publicationItem, useCvFieldArray, WatchedTitle } from "./shared";

export function PublicationsEditor({ name }: { name: string }) {
  const { register } = useFormContext<CvData>();
  const { fields, append, remove, move } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <SortableList
        items={fields}
        getId={(field) => field.id}
        onMove={move}
        className="rounded-md border border-slate-200 px-3"
        handleLabel="Reorder publication"
        renderContainer={(children, className) => (
          <Accordion type="multiple" className={className}>
            {children}
          </Accordion>
        )}
        renderItem={({ item: field, index, dragHandle }) => (
          <AccordionItem value={field.id}>
            <div className="flex items-center gap-1">
              {dragHandle}
              <AccordionTrigger>
                <WatchedTitle
                  name={`${name}.${index}.title`}
                  fallback={`Publication ${index + 1}`}
                />
              </AccordionTrigger>
            </div>
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
        )}
      />
      <Button type="button" variant="secondary" onClick={() => append(publicationItem() as never)}>
        <Plus />
        Add publication
      </Button>
    </div>
  );
}
