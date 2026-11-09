import { describe, expect, it } from "vitest";
import { sampleCvDataEn } from "./sample-data";
import { cvSchema } from "./schema";
describe("current CV schema", () => {
  it("round trips current content without changing it", () => {
    expect(cvSchema.parse(sampleCvDataEn)).toEqual(sampleCvDataEn);
  });
  it.each([5, 6, 8, undefined])("rejects version %s", schemaVersion => {
    expect(cvSchema.safeParse({
      ...sampleCvDataEn,
      schemaVersion
    }).success).toBe(false);
  });
  it("rejects missing current fields without adding defaults", () => {
    const payload = structuredClone(sampleCvDataEn) as Record<string, unknown>;
    delete payload.sectionOrder;
    const before = JSON.stringify(payload);
    expect(cvSchema.safeParse(payload).success).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
    const sections = structuredClone(sampleCvDataEn.sectionTitles);
    delete (sections.profile as Partial<typeof sections.profile>).pageBreakBefore;
    expect(cvSchema.safeParse({
      ...sampleCvDataEn,
      sectionTitles: sections
    }).success).toBe(false);
  });
});
