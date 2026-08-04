"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useFormContext } from "react-hook-form";

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Field, FieldGrid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SortableAccordionList } from "@/components/ui/sortable-list";
import type { CvData, CvSectionId } from "@/lib/cv/schema";

import { PolishEntryButton } from "../polish/polish-entry-button";
import { BulletEditor } from "./text-items-editor";
import { fieldPath, oneLineEntryItem, useCvFieldArray, WatchedTitle } from "./shared";

export function OneLineEntriesEditor({
  name,
  addLabel,
  polishSectionId,
}: {
  name: string;
  addLabel: string;
  /**
   * The section this list belongs to: enables the entry-granularity AI
   * button on each accordion row and item-granularity buttons on bullets
   * (visibility still gated by flag + matrix).
   */
  polishSectionId?: CvSectionId;
}) {
  const { register } = useFormContext<CvData>();
  const t = useTranslations("Editors.Research");
  const { fields, append, remove, move } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <SortableAccordionList
        items={fields}
        getId={(field) => field.id}
        onMove={move}
        className="rounded-md border border-border px-3"
        handleLabel={t("reorder")}
        renderItem={({ item: field, index, dragHandle }) => (
          <AccordionItem value={field.id}>
            <div className="flex items-center gap-1">
              {dragHandle}
              <AccordionTrigger>
                <WatchedTitle name={`${name}.${index}.title`} fallback={t("fallback", { index: index + 1 })} />
              </AccordionTrigger>
              {polishSectionId && (
                <PolishEntryButton
                  scope={{ sectionId: polishSectionId, granularity: "entry", entryId: `${index}` }}
                />
              )}
            </div>
            <AccordionContent>
              <div className="space-y-3">
                <FieldGrid>
                  <Field label={t("title")}>
                    <Input {...register(fieldPath(`${name}.${index}.title`))} />
                  </Field>
                  <Field label={t("date")}>
                    <Input {...register(fieldPath(`${name}.${index}.date`))} />
                  </Field>
                </FieldGrid>
                <BulletEditor
                  name={`${name}.${index}.bullets`}
                  polish={
                    polishSectionId
                      ? { sectionId: polishSectionId, entryId: `${index}` }
                      : undefined
                  }
                />
                <Button type="button" variant="destructive" size="sm" onClick={() => remove(index)}>
                  <Trash2 />
                  {t("remove")}
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
