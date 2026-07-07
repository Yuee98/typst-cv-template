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
import type { CvData } from "@/lib/cv/schema";

import { BulletEditor } from "./text-items-editor";
import { companyItem, fieldPath, projectItem, useCvFieldArray, WatchedTitle } from "./shared";

function ProjectEditor({
  companyIndex,
  projectIndex,
}: {
  companyIndex: number;
  projectIndex: number;
}) {
  const { register } = useFormContext<CvData>();
  const t = useTranslations("Editors.Experience");
  const base = `experience.${companyIndex}.projects.${projectIndex}`;

  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      <FieldGrid>
        <Field label={t("projectTitle")}>
          <Input {...register(fieldPath(`${base}.title`))} />
        </Field>
        <Field label={t("projectDetail")}>
          <Input {...register(fieldPath(`${base}.detail`))} />
        </Field>
        <Field label={t("projectDate")}>
          <Input {...register(fieldPath(`${base}.date`))} />
        </Field>
      </FieldGrid>
      <BulletEditor name={`${base}.bullets`} />
    </div>
  );
}

function CompanyEditor({ companyIndex }: { companyIndex: number }) {
  const { register } = useFormContext<CvData>();
  const t = useTranslations("Editors.Experience");
  const base = `experience.${companyIndex}`;
  const { fields, append, remove, move } = useCvFieldArray(`${base}.projects`);

  return (
    <div className="space-y-4">
      <FieldGrid>
        <Field label={t("company")}>
          <Input {...register(fieldPath(`${base}.org`))} />
        </Field>
        <Field label={t("companyDate")}>
          <Input {...register(fieldPath(`${base}.date`))} />
        </Field>
      </FieldGrid>
      <div className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-foreground-muted">{t("projects")}</div>
        <SortableAccordionList
          items={fields}
          getId={(field) => field.id}
          onMove={move}
          className="rounded-md border border-border px-3"
          handleLabel={t("reorderProject")}
          renderItem={({ item: field, index: projectIndex, dragHandle }) => (
            <AccordionItem value={field.id}>
              <div className="flex items-center gap-1">
                {dragHandle}
                <AccordionTrigger>
                  <WatchedTitle
                    name={`${base}.projects.${projectIndex}.detail`}
                    fallback={t("projectFallback", { index: projectIndex + 1 })}
                  />
                </AccordionTrigger>
              </div>
              <AccordionContent>
                <div className="space-y-3">
                  <ProjectEditor
                    companyIndex={companyIndex}
                    projectIndex={projectIndex}
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => remove(projectIndex)}
                  >
                    <Trash2 />
                    {t("removeProject")}
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          )}
        />
        <Button type="button" variant="secondary" onClick={() => append(projectItem() as never)}>
          <Plus />
          {t("addProject")}
        </Button>
      </div>
    </div>
  );
}

export function ExperienceEditor() {
  const t = useTranslations("Editors.Experience");
  const name = "experience";
  const { fields, append, remove, move } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <SortableAccordionList
        items={fields}
        getId={(field) => field.id}
        onMove={move}
        className="rounded-md border border-border px-3"
        handleLabel={t("reorderCompany")}
        renderItem={({ item: field, index, dragHandle }) => (
          <AccordionItem value={field.id}>
            <div className="flex items-center gap-1">
              {dragHandle}
              <AccordionTrigger>
                <WatchedTitle name={`${name}.${index}.org`} fallback={t("companyFallback", { index: index + 1 })} />
              </AccordionTrigger>
            </div>
            <AccordionContent>
              <div className="space-y-3">
                <CompanyEditor companyIndex={index} />
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => remove(index)}
                >
                  <Trash2 />
                  {t("removeCompany")}
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      />
      <Button type="button" variant="secondary" onClick={() => append(companyItem() as never)}>
        <Plus />
        {t("addCompany")}
      </Button>
    </div>
  );
}
