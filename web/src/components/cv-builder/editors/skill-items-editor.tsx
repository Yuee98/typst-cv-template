"use client";

import { Plus, Trash2 } from "lucide-react";
import { useFormContext } from "react-hook-form";

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SortableAccordionList } from "@/components/ui/sortable-list";
import { Textarea } from "@/components/ui/textarea";
import type { CvData } from "@/lib/cv/schema";

import { fieldPath, skillItem, useCvFieldArray, WatchedTitle } from "./shared";

export function SkillItemsEditor({
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
      <SortableAccordionList
        items={fields}
        getId={(field) => field.id}
        onMove={move}
        className="rounded-md border border-slate-200 px-3"
        handleLabel="Reorder skill"
        renderItem={({ item: field, index, dragHandle }) => (
          <AccordionItem value={field.id}>
            <div className="flex items-center gap-1">
              {dragHandle}
              <AccordionTrigger>
                <WatchedTitle name={`${name}.${index}.label`} fallback={`Skill ${index + 1}`} />
              </AccordionTrigger>
            </div>
            <AccordionContent>
              <div className="space-y-3">
                <Field label="Label">
                  <Input {...register(fieldPath(`${name}.${index}.label`))} />
                </Field>
                <Field label="Body">
                  <Textarea {...register(fieldPath(`${name}.${index}.body`))} />
                </Field>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => remove(index)}
                >
                  <Trash2 />
                  Remove skill
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      />
      <Button type="button" variant="secondary" onClick={() => append(skillItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}
