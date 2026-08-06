import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SECTION_ORDER } from "@/lib/cv/schema";

import {
  reorderSectionOrder,
  writeSectionOrder,
} from "./section-order";

describe("section-order helpers", () => {
  it("moves a section within a normalized order", () => {
    const order = reorderSectionOrder(
      ["skills", "skills", "profile"] as const,
      "profile",
      "skills",
    );

    expect(order).toEqual([
      "profile",
      "skills",
      "experience",
      "education",
      "research",
      "publications",
      "additional",
    ]);
    expect(order).toHaveLength(DEFAULT_SECTION_ORDER.length);
  });

  it.each([
    ["skills", "skills"],
    ["missing", "skills"],
    ["skills", "missing"],
  ])("rejects invalid or no-op drops (%s -> %s)", (activeId, overId) => {
    expect(reorderSectionOrder(DEFAULT_SECTION_ORDER, activeId, overId)).toBeNull();
  });

  it("writes RHF sectionOrder with all existing state flags", () => {
    const setValue = vi.fn();
    const nextOrder = [...DEFAULT_SECTION_ORDER].reverse();

    writeSectionOrder(setValue, nextOrder);

    expect(setValue).toHaveBeenCalledWith("sectionOrder", nextOrder, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  });
});
