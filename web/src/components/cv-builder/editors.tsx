"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  type FieldArrayPath,
  type FieldPath,
  useFieldArray,
  useFormContext,
  useWatch,
} from "react-hook-form";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Field, FieldGrid } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { CvData } from "@/lib/cv/schema";

const fieldPath = (value: string) => value as FieldPath<CvData>;
const arrayPath = (value: string) => value as FieldArrayPath<CvData>;

const textItem = () => ({ body: "" });
const skillItem = () => ({ label: "", body: "" });
const projectItem = () => ({
  title: "",
  detail: "",
  date: "",
  bullets: [textItem()],
});
const companyItem = () => ({
  org: "",
  date: "",
  projects: [projectItem()],
});
const resumeEntryItem = () => ({
  org: "",
  title: "",
  detail: "",
  date: "",
  bullets: [],
});
const oneLineEntryItem = () => ({
  title: "",
  date: "",
  bullets: [textItem()],
});
const publicationItem = () => ({
  label: "",
  body: "",
});

function useCvFieldArray(name: string) {
  const { control } = useFormContext<CvData>();
  return useFieldArray({ control, name: arrayPath(name) });
}

function WatchedTitle({ name, fallback }: { name: string; fallback: string }) {
  const { control } = useFormContext<CvData>();
  const value = useWatch({ control, name: fieldPath(name) });
  return <>{typeof value === "string" && value.trim() ? value : fallback}</>;
}

function TextItemsEditor({
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
      {fields.map((field, index) => (
        <div key={field.id} className="flex items-start gap-2">
          <Field label={`Item ${index + 1}`}>
            <Textarea {...register(fieldPath(`${name}.${index}.body`))} />
          </Field>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove item"
            onClick={() => remove(index)}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => append(textItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}

function SkillItemsEditor({
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
      {fields.map((field, index) => (
        <div key={field.id} className="grid gap-3 rounded-md border border-slate-200 p-3">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove item"
              onClick={() => remove(index)}
            >
              <Trash2 />
            </Button>
          </div>
          <FieldGrid>
            <Field label="Label">
              <Input {...register(fieldPath(`${name}.${index}.label`))} />
            </Field>
            <Field label="Body">
              <Input {...register(fieldPath(`${name}.${index}.body`))} />
            </Field>
          </FieldGrid>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => append(skillItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}

function BulletEditor({ name }: { name: string }) {
  return <TextItemsEditor name={name} addLabel="Add bullet" />;
}

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

function ExperienceEditor() {
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

function ResumeEntriesEditor({
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
              <WatchedTitle name={`${name}.${index}.org`} fallback={`Entry ${index + 1}`} />
            </AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-3">
                <FieldGrid>
                  <Field label="Organization">
                    <Input {...register(fieldPath(`${name}.${index}.org`))} />
                  </Field>
                  <Field label="Date">
                    <Input {...register(fieldPath(`${name}.${index}.date`))} />
                  </Field>
                  <Field label="Title">
                    <Input {...register(fieldPath(`${name}.${index}.title`))} />
                  </Field>
                  <Field label="Detail">
                    <Input {...register(fieldPath(`${name}.${index}.detail`))} />
                  </Field>
                </FieldGrid>
                <BulletEditor name={`${name}.${index}.bullets`} />
                <Button type="button" variant="destructive" size="sm" onClick={() => remove(index)}>
                  <Trash2 />
                  Remove entry
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      <Button type="button" variant="secondary" onClick={() => append(resumeEntryItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}

function OneLineEntriesEditor({
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
      {fields.map((field, index) => (
        <div key={field.id} className="grid gap-3 rounded-md border border-slate-200 p-3">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove entry"
              onClick={() => remove(index)}
            >
              <Trash2 />
            </Button>
          </div>
          <FieldGrid>
            <Field label="Title">
              <Input {...register(fieldPath(`${name}.${index}.title`))} />
            </Field>
            <Field label="Date">
              <Input {...register(fieldPath(`${name}.${index}.date`))} />
            </Field>
          </FieldGrid>
          <BulletEditor name={`${name}.${index}.bullets`} />
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => append(oneLineEntryItem() as never)}>
        <Plus />
        {addLabel}
      </Button>
    </div>
  );
}

function PublicationsEditor({ name }: { name: string }) {
  const { register } = useFormContext<CvData>();
  const { fields, append, remove } = useCvFieldArray(name);

  return (
    <div className="space-y-3">
      {fields.map((field, index) => (
        <div key={field.id} className="grid gap-3 rounded-md border border-slate-200 p-3">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove publication"
              onClick={() => remove(index)}
            >
              <Trash2 />
            </Button>
          </div>
          <FieldGrid>
            <Field label="Label">
              <Input {...register(fieldPath(`${name}.${index}.label`))} />
            </Field>
            <Field label="Body">
              <Textarea {...register(fieldPath(`${name}.${index}.body`))} />
            </Field>
          </FieldGrid>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => append(publicationItem() as never)}>
        <Plus />
        Add publication
      </Button>
    </div>
  );
}

function HeaderEditor() {
  const { register } = useFormContext<CvData>();
  const base = "header";

  return (
    <div className="grid gap-4">
      <FieldGrid>
        <Field label="Name">
          <Input {...register(fieldPath(`${base}.name`))} />
        </Field>
        <Field label="Subtitle">
          <Input {...register(fieldPath(`${base}.subtitle`))} />
        </Field>
        <Field label="Email">
          <Input {...register(fieldPath(`${base}.email`))} />
        </Field>
        <Field label="Phone">
          <Input {...register(fieldPath(`${base}.phone`))} />
        </Field>
      </FieldGrid>
    </div>
  );
}

function SectionTitleEditor() {
  const { register } = useFormContext<CvData>();
  const base = "sectionTitles";

  return (
    <FieldGrid>
      <Field label="Profile">
        <Input {...register(fieldPath(`${base}.profile`))} />
      </Field>
      <Field label="Skills">
        <Input {...register(fieldPath(`${base}.skills`))} />
      </Field>
      <Field label="Experience">
        <Input {...register(fieldPath(`${base}.experience`))} />
      </Field>
      <Field label="Education">
        <Input {...register(fieldPath(`${base}.education`))} />
      </Field>
      <Field label="Research">
        <Input {...register(fieldPath(`${base}.research`))} />
      </Field>
      <Field label="Publications">
        <Input {...register(fieldPath(`${base}.publications`))} />
      </Field>
      <Field label="Additional">
        <Input {...register(fieldPath(`${base}.additional`))} />
      </Field>
    </FieldGrid>
  );
}

export function CvEditor() {
  return (
    <Panel title="Editor" className="editor-pane h-full min-h-[720px] overflow-hidden">
      <Tabs defaultValue="header" className="flex h-full min-h-0 flex-col">
        <TabsList>
          <TabsTrigger value="header">Header</TabsTrigger>
          <TabsTrigger value="sections">Sections</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="experience">Experience</TabsTrigger>
          <TabsTrigger value="education">Education</TabsTrigger>
          <TabsTrigger value="research">Research</TabsTrigger>
          <TabsTrigger value="publications">Publications</TabsTrigger>
          <TabsTrigger value="additional">Additional</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-auto">
          <TabsContent value="header">
            <HeaderEditor />
          </TabsContent>
          <TabsContent value="sections">
            <SectionTitleEditor />
          </TabsContent>
          <TabsContent value="profile">
            <TextItemsEditor name="profile" addLabel="Add profile item" />
          </TabsContent>
          <TabsContent value="skills">
            <SkillItemsEditor name="skills" addLabel="Add skill" />
          </TabsContent>
          <TabsContent value="experience">
            <ExperienceEditor />
          </TabsContent>
          <TabsContent value="education">
            <ResumeEntriesEditor name="education" addLabel="Add education" />
          </TabsContent>
          <TabsContent value="research">
            <OneLineEntriesEditor name="research" addLabel="Add research" />
          </TabsContent>
          <TabsContent value="publications">
            <PublicationsEditor name="publications" />
          </TabsContent>
          <TabsContent value="additional">
            <SkillItemsEditor name="additional" addLabel="Add item" />
          </TabsContent>
        </div>
      </Tabs>
    </Panel>
  );
}
