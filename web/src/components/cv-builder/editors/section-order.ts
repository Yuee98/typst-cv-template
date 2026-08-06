import {
  normalizeSectionOrder,
  type CvSectionId,
} from "@/lib/cv/schema";

export interface SectionOrderWriteOptions {
  shouldDirty: true;
  shouldTouch: true;
  shouldValidate: true;
}

export type SectionOrderWriter = (
  name: "sectionOrder",
  value: CvSectionId[],
  options: SectionOrderWriteOptions,
) => void;

/**
 * Return a normalized section order with one valid item moved, or null when a
 * drag is invalid or a no-op.  Keeping this calculation pure leaves the DnD
 * event owner responsible for RHF writes and the associated dirty/touch/
 * validation flags.
 */
export function reorderSectionOrder(
  order: readonly CvSectionId[],
  activeId: string,
  overId: string,
): CvSectionId[] | null {
  const normalized = normalizeSectionOrder(order);
  if (activeId === overId) return null;

  const fromIndex = normalized.indexOf(activeId as CvSectionId);
  const toIndex = normalized.indexOf(overId as CvSectionId);
  if (fromIndex === -1 || toIndex === -1) return null;

  const nextOrder = [...normalized];
  const [moved] = nextOrder.splice(fromIndex, 1);
  if (!moved) return null;
  nextOrder.splice(toIndex, 0, moved);
  return nextOrder;
}

/** Commit the normalized order with the existing RHF dirty/touch/validate contract. */
export function writeSectionOrder(
  setValue: SectionOrderWriter,
  nextOrder: CvSectionId[],
): void {
  setValue("sectionOrder", nextOrder, {
    shouldDirty: true,
    shouldTouch: true,
    shouldValidate: true,
  });
}
