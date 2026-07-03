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

import { BulletEditor } from "./text-items-editor";
import { fieldPath, oneLineEntryItem, useCvFieldArray, WatchedTitle } from "./shared";

export function OneLineEntriesEditor({
  name,
  addLabel,
}: {
  name: string;
  addLabel: string;
}) {
  const { register } = useFormContext<CvData>();
  const { fields, append, remove, move } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <SortableList
        items={fields}
        getId={(field) => field.id}
        onMove={move}
        className="rounded-md border border-slate-200 px-3"
        handleLabel="Reorder entry"
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
                <WatchedTitle name={`${name}.${index}.title`} fallback={`Entry ${index + 1}`} />
              </AccordionTrigger>
            </div>
            <AccordionContent>
              <div className="space-y-3">
                <FieldGrid>
                  <Field label="Title">
                    <Input {...register(fieldPath(`${name}.${index}.title`))} />
                  </Field>
                  <Field label="Date">
                    <Input {...register(fieldPath(`${name}.${index}.date`))} />
                  </Field>
                </FieldGrid>
                <BulletEditor name={`${name}.${index}.bullets`} />
                <Button type="button" variant="destructive" size="sm" onClick={() => remove(index)}>
                  <Trash2 />
                  Remove research
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      />
      <Button type="button" variant="secondary" onClick={() => append(oneLineEntryItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}
