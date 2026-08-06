import { describe, expect, it } from "vitest";

import { sampleCvDataEn } from "@/lib/cv/sample-data";
import {
  CV_SCHEMA_VERSION,
  DEFAULT_SECTION_ORDER,
  persistedCvSchema,
} from "@/lib/cv/schema";

function cloneSample() {
  return JSON.parse(JSON.stringify(sampleCvDataEn)) as Record<string, unknown>;
}

function legacyPayload(version: 5 | 6) {
  const payload = cloneSample();
  payload.schemaVersion = version;

  if (version === 5) {
    delete payload.sectionOrder;
  } else {
    payload.sectionOrder = ["publications", "profile", "publications"];
  }

  const sectionTitles = payload.sectionTitles as Record<string, Record<string, unknown>>;
  for (const section of Object.values(sectionTitles)) {
    delete section.pageBreakBefore;
  }

  return payload;
}

describe("persistedCvSchema", () => {
  it("accepts current v7 data without changing its meaning", () => {
    const result = persistedCvSchema.safeParse(sampleCvDataEn);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toEqual(sampleCvDataEn);
    expect(result.data.schemaVersion).toBe(CV_SCHEMA_VERSION);
    expect(result.data.sectionOrder).toEqual(DEFAULT_SECTION_ORDER);
  });

  it("upgrades v5 data with the current version, section order, and page-break defaults", () => {
    const result = persistedCvSchema.safeParse(legacyPayload(5));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.schemaVersion).toBe(7);
    expect(result.data.sectionOrder).toEqual(DEFAULT_SECTION_ORDER);
    expect(result.data.sectionTitles).toEqual(
      Object.fromEntries(
        DEFAULT_SECTION_ORDER.map((sectionId) => [
          sectionId,
          { ...sampleCvDataEn.sectionTitles[sectionId], pageBreakBefore: false },
        ]),
      ),
    );
    expect(result.data.header).toEqual(sampleCvDataEn.header);
  });

  it("upgrades v6 data while preserving unique order and appending missing sections", () => {
    const result = persistedCvSchema.safeParse(legacyPayload(6));

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.schemaVersion).toBe(7);
    expect(result.data.sectionOrder).toEqual([
      "publications",
      "profile",
      "skills",
      "experience",
      "education",
      "research",
      "additional",
    ]);
    expect(result.data.sectionTitles.publications.pageBreakBefore).toBe(false);
  });

  it("rejects unsupported versions and malformed persisted payloads", () => {
    const unsupported = { ...cloneSample(), schemaVersion: 8 };
    const malformed = { ...cloneSample(), header: { ...sampleCvDataEn.header, name: 42 } };

    expect(persistedCvSchema.safeParse(unsupported).success).toBe(false);
    expect(persistedCvSchema.safeParse(malformed).success).toBe(false);
    expect(persistedCvSchema.safeParse(null).success).toBe(false);
  });

  it("does not mutate input data while applying compatibility defaults", () => {
    const payload = legacyPayload(5);
    const before = JSON.stringify(payload);

    const result = persistedCvSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(JSON.stringify(payload)).toBe(before);
  });
});
