"use client";

import { Plus, Trash2 } from "lucide-react";
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
  const base = `experience.${companyIndex}.projects.${projectIndex}`;

  return (
    <div className="grid gap-3 rounded-md border border-slate-200 p-3">
      <FieldGrid>
        <Field label="Title">
          <Input {...register(fieldPath(`${base}.title`))} />
        </Field>
        <Field label="Detail">
          <Input {...register(fieldPath(`${base}.detail`))} />
        </Field>
        <Field label="Project date">
          <Input {...register(fieldPath(`${base}.date`))} />
        </Field>
      </FieldGrid>
      <BulletEditor name={`${base}.bullets`} />
    </div>
  );
}

function CompanyEditor({ companyIndex }: { companyIndex: number }) {
  const { register } = useFormContext<CvData>();
  const base = `experience.${companyIndex}`;
  const { fields, append, remove, move } = useCvFieldArray(`${base}.projects`);

  return (
    <div className="space-y-4">
      <FieldGrid>
        <Field label="Company">
          <Input {...register(fieldPath(`${base}.org`))} />
        </Field>
        <Field label="Company date">
          <Input {...register(fieldPath(`${base}.date`))} />
        </Field>
      </FieldGrid>
      <div className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Projects</div>
        <SortableAccordionList
          items={fields}
          getId={(field) => field.id}
          onMove={move}
          className="rounded-md border border-slate-200 px-3"
          handleLabel="Reorder project"
          renderItem={({ item: field, index: projectIndex, dragHandle }) => (
            <AccordionItem value={field.id}>
              <div className="flex items-center gap-1">
                {dragHandle}
                <AccordionTrigger>
                  <WatchedTitle
                    name={`${base}.projects.${projectIndex}.detail`}
                    fallback={`Project ${projectIndex + 1}`}
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
                    Remove project
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          )}
        />
        <Button type="button" variant="secondary" onClick={() => append(projectItem() as never)}>
          <Plus />
          Add project
        </Button>
      </div>
    </div>
  );
}

export function ExperienceEditor() {
  const name = "experience";
  const { fields, append, remove, move } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <SortableAccordionList
        items={fields}
        getId={(field) => field.id}
        onMove={move}
        className="rounded-md border border-slate-200 px-3"
        handleLabel="Reorder company"
        renderItem={({ item: field, index, dragHandle }) => (
          <AccordionItem value={field.id}>
            <div className="flex items-center gap-1">
              {dragHandle}
              <AccordionTrigger>
                <WatchedTitle name={`${name}.${index}.org`} fallback={`Company ${index + 1}`} />
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
                  Remove company
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      />
      <Button type="button" variant="secondary" onClick={() => append(companyItem() as never)}>
        <Plus />
        Add company
      </Button>
    </div>
  );
}
