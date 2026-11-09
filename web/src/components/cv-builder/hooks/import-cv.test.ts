// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { parseImportedCvFile } from "@/components/cv-builder/hooks/import-cv";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";
describe("parseImportedCvFile", () => {
  it("returns null for a missing file without attempting a document transition", async () => {
    await expect(parseImportedCvFile(undefined, "Imported CV")).resolves.toBeNull();
  });
  it("parses JSON through cvSchema and derives the imported title", async () => {
    const result = await parseImportedCvFile(new File([JSON.stringify(sampleCvDataEn)], "current.json", {
      type: "application/json"
    }), "Fallback CV");
    expect(result?.data.schemaVersion).toBe(7);
    expect(result?.data.sectionOrder).toEqual(sampleCvDataEn.sectionOrder);
    expect(result?.title).toBe("Lin Zhou CV");
  });
  it.each([5, 6, 8, undefined])("rejects unsupported version %s", async schemaVersion => {
    const payload = {
      ...sampleCvDataEn,
      schemaVersion
    };
    await expect(parseImportedCvFile(new File([JSON.stringify(payload)], "old.json"), "Fallback")).resolves.toBeNull();
  });
  it("uses the fallback title when imported data has no name", async () => {
    const data = cloneCvData(sampleCvDataEn);
    data.header.name = "";
    const result = await parseImportedCvFile(new File([JSON.stringify(data)], "unnamed.json"), "Imported fallback");
    expect(result?.title).toBe("Imported fallback");
  });
  it("returns null for schema-invalid JSON and preserves JSON parse errors", async () => {
    const invalid = new File([JSON.stringify({
      schemaVersion: 7
    })], "invalid.json");
    const malformed = new File(["not-json"], "malformed.json");
    await expect(parseImportedCvFile(invalid, "Fallback CV")).resolves.toBeNull();
    await expect(parseImportedCvFile(malformed, "Fallback CV")).rejects.toThrow();
  });
});
