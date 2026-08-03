import { describe, expect, it } from "vitest";

import type { CvSectionId } from "@/lib/cv/schema";
import { POLISH_GRANULARITIES, type PolishGranularity } from "@/lib/polish/contract";

import {
  canOfferPolishEntry,
  isAiPolishUiEnabled,
  isPolishEntryVisible,
  polishItemId,
} from "./polish-entry";

describe("isAiPolishUiEnabled", () => {
  it('is true only for the exact string "true"', () => {
    expect(isAiPolishUiEnabled("true")).toBe(true);
  });

  it.each([undefined, "", "false", "1", "TRUE", " true "])(
    "is false for %j",
    (flagValue) => {
      expect(isAiPolishUiEnabled(flagValue)).toBe(false);
    },
  );
});

describe("canOfferPolishEntry (capability matrix)", () => {
  const expected: Record<CvSectionId, readonly PolishGranularity[]> = {
    profile: ["item", "entry"],
    skills: ["item", "section"],
    experience: ["item", "entry", "section"],
    education: ["item", "entry", "section"],
    research: ["item", "entry", "section"],
    publications: [],
    additional: ["item", "section"],
  };

  it.each(Object.entries(expected))("%s offers exactly %j", (sectionId, granularities) => {
    for (const granularity of POLISH_GRANULARITIES) {
      expect(canOfferPolishEntry(sectionId as CvSectionId, granularity)).toBe(
        granularities.includes(granularity),
      );
    }
  });

  it("publications never gets an entry", () => {
    for (const granularity of POLISH_GRANULARITIES) {
      expect(canOfferPolishEntry("publications", granularity)).toBe(false);
    }
  });
});

describe("isPolishEntryVisible", () => {
  it("requires the flag even for a valid section/granularity pair", () => {
    expect(isPolishEntryVisible("experience", "item", "true")).toBe(true);
    expect(isPolishEntryVisible("experience", "item", undefined)).toBe(false);
    expect(isPolishEntryVisible("experience", "item", "false")).toBe(false);
  });

  it("requires matrix support even with the flag on", () => {
    expect(isPolishEntryVisible("profile", "section", "true")).toBe(false);
    expect(isPolishEntryVisible("skills", "entry", "true")).toBe(false);
    expect(isPolishEntryVisible("publications", "item", "true")).toBe(false);
    expect(isPolishEntryVisible("profile", "entry", "true")).toBe(true);
  });
});

describe("polishItemId", () => {
  it("flat lists use the bare item index", () => {
    expect(polishItemId(undefined, 0)).toBe("0");
    expect(polishItemId(undefined, 12)).toBe("12");
  });

  it("nested lists prefix the entry path", () => {
    expect(polishItemId("2", 1)).toBe("2.1");
    expect(polishItemId("0.3", 4)).toBe("0.3.4");
  });
});
