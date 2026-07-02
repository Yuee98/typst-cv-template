import { type FieldArrayPath, type FieldPath, useFieldArray, useFormContext, useWatch } from "react-hook-form";

import type { CvData } from "@/lib/cv/schema";

export const fieldPath = (value: string) => value as FieldPath<CvData>;
export const arrayPath = (value: string) => value as FieldArrayPath<CvData>;

export const textItem = () => ({ body: "" });
export const skillItem = () => ({ label: "", body: "" });
export const projectItem = () => ({
  title: "",
  detail: "",
  date: "",
  bullets: [textItem()],
});
export const companyItem = () => ({
  org: "",
  date: "",
  projects: [projectItem()],
});
export const resumeEntryItem = () => ({
  org: "",
  title: "",
  detail: "",
  date: "",
  bullets: [],
});
export const oneLineEntryItem = () => ({
  title: "",
  date: "",
  bullets: [textItem()],
});
export const publicationItem = () => ({
  authors: "",
  title: "",
  venue: "",
  year: "",
  url: "",
});

export function useCvFieldArray(name: string) {
  const { control } = useFormContext<CvData>();
  return useFieldArray({ control, name: arrayPath(name) });
}

export function WatchedTitle({ name, fallback }: { name: string; fallback: string }) {
  const { control } = useFormContext<CvData>();
  const value = useWatch({ control, name: fieldPath(name) });
  return <>{typeof value === "string" && value.trim() ? value : fallback}</>;
}
