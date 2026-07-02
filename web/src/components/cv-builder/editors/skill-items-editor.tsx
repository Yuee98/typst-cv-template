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
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
  const { fields, append, remove } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <Accordion type="multiple" className="rounded-md border border-slate-200 px-3">
        {fields.map((field, index) => (
          <AccordionItem key={field.id} value={field.id}>
            <AccordionTrigger>
              <WatchedTitle name={`${name}.${index}.label`} fallback={`Skill ${index + 1}`} />
            </AccordionTrigger>
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
        ))}
      </Accordion>
      <Button type="button" variant="secondary" onClick={() => append(skillItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}
