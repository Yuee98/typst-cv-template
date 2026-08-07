/**
 * Entry-point gating for the AI polish editor buttons (unit 3.5).
 *
 * Two independent gates, both pure and testable:
 *
 * - Deployment flag: NEXT_PUBLIC_AI_POLISH_ENABLED controls ONLY the
 *   visibility of the UI entries (roadmap「功能开关」: 仅控制前端按钮显隐,
 *   not a security switch). Anything other than the exact string "true"
 *   means no entry renders at all — not disabled, absent (Invariant 9: the
 *   static export is always built without the flag, so its artifact can
 *   never contain an AI entry; run-next-mode.mjs refuses the conflicting
 *   build anyway).
 * - Capability matrix: a button is only offered when
 *   getSectionCapability(sectionId) lists the granularity (roadmap
 *   「粒度与能力矩阵」). This is what guarantees publications never gets an
 *   AI button even if a mount site is added by mistake, and that profile
 *   can never expose a section-granularity scope (its entry level == its
 *   section level).
 */

import type { CvSectionId } from "@/lib/cv/schema";
import { getSectionCapability, type PolishGranularity } from "@/lib/polish/contract";
import { isAiPolishUiEnabled } from "@/lib/polish/feature-flags";

export { isAiPolishUiEnabled };

/** The capability matrix is the single source for which scopes a section offers. */
export function canOfferPolishEntry(
  sectionId: CvSectionId,
  granularity: PolishGranularity,
): boolean {
  return Boolean(getSectionCapability(sectionId)?.granularities.includes(granularity));
}

/** An entry button renders only when both gates pass. */
export function isPolishEntryVisible(
  sectionId: CvSectionId,
  granularity: PolishGranularity,
  flagValue?: string,
): boolean {
  return isAiPolishUiEnabled(flagValue) && canOfferPolishEntry(sectionId, granularity);
}

/**
 * Dot-joined zero-based index path of an item inside its section (the
 * scope-builder id semantics): flat lists (profile/skills/additional) have
 * no containing entry, so the item id is just the item index; nested lists
 * prefix the entry path (experience "<company>.<project>.<bullet>",
 * education/research "<entry>.<bullet>").
 */
export function polishItemId(entryId: string | undefined, itemIndex: number): string {
  return entryId === undefined ? `${itemIndex}` : `${entryId}.${itemIndex}`;
}

/**
 * What an items-list editor needs to build per-item scopes: which section
 * the list belongs to and, for nested lists, the containing entry's id.
 */
export interface PolishItemScopeBase {
  sectionId: CvSectionId;
  /** Dot-joined index path of the containing entry; omitted for flat lists. */
  entryId?: string;
}
