// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { parseImportedCvFile } from "@/components/cv-builder/hooks/import-cv";
import { cloneCvData } from "@/lib/cv/cv-utils";
import { sampleCvDataEn } from "@/lib/cv/sample-data";

describe("parseImportedCvFile", () => {
  it("returns null for a missing file without attempting a document transition", async () => {
    await expect(parseImportedCvFile(undefined, "Imported CV")).resolves.toBeNull();
  });

  it("parses JSON through persistedCvSchema and derives the imported title", async () => {
    const legacy = JSON.parse(JSON.stringify(sampleCvDataEn)) as Record<string, unknown>;
    legacy.schemaVersion = 5;
    delete legacy.sectionOrder;
    for (const section of Object.values(
      legacy.sectionTitles as Record<string, Record<string, unknown>>,
    )) {
      delete section.pageBreakBefore;
    }

    const result = await parseImportedCvFile(
      new File([JSON.stringify(legacy)], "legacy.json", { type: "application/json" }),
      "Fallback CV",
    );

    expect(result?.data.schemaVersion).toBe(7);
    expect(result?.data.sectionOrder).toEqual(sampleCvDataEn.sectionOrder);
    expect(result?.title).toBe("Lin Zhou CV");
  });

  it("uses the fallback title when imported data has no name", async () => {
    const data = cloneCvData(sampleCvDataEn);
    data.header.name = "";

    const result = await parseImportedCvFile(
      new File([JSON.stringify(data)], "unnamed.json"),
      "Imported fallback",
    );

    expect(result?.title).toBe("Imported fallback");
  });

  it("returns null for schema-invalid JSON and preserves JSON parse errors", async () => {
    const invalid = new File([JSON.stringify({ schemaVersion: 7 })], "invalid.json");
    const malformed = new File(["not-json"], "malformed.json");

    await expect(parseImportedCvFile(invalid, "Fallback CV")).resolves.toBeNull();
    await expect(parseImportedCvFile(malformed, "Fallback CV")).rejects.toThrow();
  });
});
