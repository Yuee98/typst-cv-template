import { z } from "zod";

const textItemSchema = z.object({
  body: z.string(),
});

const skillItemSchema = z.object({
  label: z.string(),
  body: z.string(),
});

const projectSchema = z.object({
  title: z.string(),
  detail: z.string(),
  date: z.string(),
  bullets: z.array(textItemSchema),
});

const companySchema = z.object({
  org: z.string(),
  date: z.string(),
  projects: z.array(projectSchema),
});

const resumeEntrySchema = z.object({
  org: z.string(),
  title: z.string(),
  detail: z.string(),
  date: z.string(),
  bullets: z.array(textItemSchema),
});

const oneLineEntrySchema = z.object({
  title: z.string(),
  date: z.string(),
  bullets: z.array(textItemSchema),
});

const publicationSchema = z.object({
  label: z.string(),
  body: z.string(),
});

const sectionTitlesSchema = z.object({
  profile: z.string(),
  skills: z.string(),
  experience: z.string(),
  education: z.string(),
  research: z.string(),
  publications: z.string(),
  additional: z.string(),
});

const headerSchema = z.object({
  name: z.string(),
  subtitle: z.string(),
  email: z.string(),
  phone: z.string(),
});

export const cvSchema = z.object({
  schemaVersion: z.literal(3),
  typstLang: z.enum(["zh", "en"]),
  bodyFont: z.string().optional(),
  header: headerSchema,
  sectionTitles: sectionTitlesSchema,
  profile: z.array(textItemSchema),
  skills: z.array(skillItemSchema),
  experience: z.array(companySchema),
  education: z.array(resumeEntrySchema),
  research: z.array(oneLineEntrySchema),
  publications: z.array(publicationSchema),
  additional: z.array(skillItemSchema),
});

export type CvData = z.infer<typeof cvSchema>;
export type TextItem = z.infer<typeof textItemSchema>;
export type SkillItem = z.infer<typeof skillItemSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Company = z.infer<typeof companySchema>;
export type ResumeEntry = z.infer<typeof resumeEntrySchema>;
export type OneLineEntry = z.infer<typeof oneLineEntrySchema>;
export type Publication = z.infer<typeof publicationSchema>;
