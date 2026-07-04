import { z } from "zod";

export const CV_SCHEMA_VERSION = 7 as const;

export const ORDERED_SECTION_IDS = [
  "profile",
  "skills",
  "experience",
  "education",
  "research",
  "publications",
  "additional",
] as const;

export type CvSectionId = (typeof ORDERED_SECTION_IDS)[number];

export const DEFAULT_SECTION_ORDER: CvSectionId[] = [...ORDERED_SECTION_IDS];

const cvSectionIdSchema = z.enum(ORDERED_SECTION_IDS);

export function normalizeSectionOrder(value: readonly CvSectionId[] | null | undefined) {
  const seen = new Set<CvSectionId>();
  const normalized: CvSectionId[] = [];

  for (const sectionId of value ?? []) {
    if (!seen.has(sectionId)) {
      seen.add(sectionId);
      normalized.push(sectionId);
    }
  }

  for (const sectionId of DEFAULT_SECTION_ORDER) {
    if (!seen.has(sectionId)) {
      normalized.push(sectionId);
    }
  }

  return normalized;
}

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
  authors: z.string(),
  title: z.string(),
  venue: z.string(),
  year: z.string(),
  url: z.string(),
});

const legacySectionTitleSchema = z.object({
  title: z.string(),
  isDisplay: z.boolean(),
});

const sectionTitleSchema = legacySectionTitleSchema.extend({
  pageBreakBefore: z.boolean(),
});

function sectionTitlesSchemaFor<T extends z.ZodType>(sectionSchema: T) {
  return z.object({
    profile: sectionSchema,
    skills: sectionSchema,
    experience: sectionSchema,
    education: sectionSchema,
    research: sectionSchema,
    publications: sectionSchema,
    additional: sectionSchema,
  });
}

const legacySectionTitlesSchema = sectionTitlesSchemaFor(legacySectionTitleSchema);
const sectionTitlesSchema = sectionTitlesSchemaFor(sectionTitleSchema);

const headerSchema = z.object({
  name: z.string(),
  subtitle: z.string(),
  email: z.string(),
  phone: z.string(),
  selfName: z.string(),
});

const cvDataShape = {
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
};

const legacyCvDataShape = {
  ...cvDataShape,
  sectionTitles: legacySectionTitlesSchema,
};

const cvSchemaV5 = z.object({
  schemaVersion: z.literal(5),
  ...legacyCvDataShape,
});

const cvSchemaV6 = z.object({
  schemaVersion: z.literal(6),
  sectionOrder: z.array(cvSectionIdSchema),
  ...legacyCvDataShape,
});

export const cvSchema = z.object({
  schemaVersion: z.literal(CV_SCHEMA_VERSION),
  sectionOrder: z.array(cvSectionIdSchema),
  ...cvDataShape,
});

type LegacySectionTitles = z.infer<typeof legacySectionTitlesSchema>;
type CurrentSectionTitles = z.infer<typeof sectionTitlesSchema>;

function normalizeSectionTitles(sectionTitles: LegacySectionTitles | CurrentSectionTitles): CurrentSectionTitles {
  return Object.fromEntries(
    ORDERED_SECTION_IDS.map((sectionId) => {
      const section = sectionTitles[sectionId];
      return [
        sectionId,
        {
          ...section,
          pageBreakBefore: "pageBreakBefore" in section ? section.pageBreakBefore : false,
        },
      ];
    }),
  ) as CurrentSectionTitles;
}

export const persistedCvSchema = z.union([cvSchema, cvSchemaV6, cvSchemaV5]).transform((data) => ({
  ...data,
  schemaVersion: CV_SCHEMA_VERSION,
  sectionOrder: normalizeSectionOrder("sectionOrder" in data ? data.sectionOrder : undefined),
  sectionTitles: normalizeSectionTitles(data.sectionTitles),
}));

export type CvData = z.infer<typeof cvSchema>;
export type TextItem = z.infer<typeof textItemSchema>;
export type SkillItem = z.infer<typeof skillItemSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Company = z.infer<typeof companySchema>;
export type ResumeEntry = z.infer<typeof resumeEntrySchema>;
export type OneLineEntry = z.infer<typeof oneLineEntrySchema>;
export type Publication = z.infer<typeof publicationSchema>;
