"use client";

import { Plus, Trash2 } from "lucide-react";
import { useFormContext } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { SortableList } from "@/components/ui/sortable-list";
import { Textarea } from "@/components/ui/textarea";
import type { CvData } from "@/lib/cv/schema";

import { fieldPath, textItem, useCvFieldArray } from "./shared";

export function TextItemsEditor({
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
        className="space-y-3"
        handleLabel="Reorder item"
        renderItem={({ index, dragHandle }) => (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              {dragHandle}
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Item {index + 1}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label="Remove item"
                onClick={() => remove(index)}
              >
                <Trash2 />
              </Button>
            </div>
            <Textarea {...register(fieldPath(`${name}.${index}.body`))} />
          </div>
        )}
      />
      <Button type="button" variant="secondary" onClick={() => append(textItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}

export function BulletEditor({ name }: { name: string }) {
  return <TextItemsEditor name={name} addLabel="Add bullet" />;
}
