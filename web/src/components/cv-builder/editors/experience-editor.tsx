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
  const { fields, append, remove } = useCvFieldArray(`${base}.projects`);

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
        <Accordion type="multiple" className="rounded-md border border-slate-200 px-3">
          {fields.map((field, projectIndex) => (
            <AccordionItem key={field.id} value={field.id}>
              <AccordionTrigger>
                <WatchedTitle
                  name={`${base}.projects.${projectIndex}.detail`}
                  fallback={`Project ${projectIndex + 1}`}
                />
              </AccordionTrigger>
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
          ))}
        </Accordion>
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
  const { fields, append, remove } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      <Accordion type="multiple" className="rounded-md border border-slate-200 px-3">
        {fields.map((field, index) => (
          <AccordionItem key={field.id} value={field.id}>
            <AccordionTrigger>
              <WatchedTitle name={`${name}.${index}.org`} fallback={`Company ${index + 1}`} />
            </AccordionTrigger>
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
        ))}
      </Accordion>
      <Button type="button" variant="secondary" onClick={() => append(companyItem() as never)}>
        <Plus />
        Add company
      </Button>
    </div>
  );
}
