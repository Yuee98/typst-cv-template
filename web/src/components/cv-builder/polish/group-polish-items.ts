/**
 * Preview grouping for the polish dialog (roadmap: preview 布局为
 * accordion+bullet 层级，section 粒度时按 entry 分组).
 *
 * Groups are derived from the items' RHF paths — the wire format carries no
 * entry grouping by design, but the local paths do:
 * - experience: experience.{company}.projects.{project}.bullets.{n}.body
 * - education / research: {section}.{entry}.bullets.{n}.body
 * - profile / skills / additional: flat — a single unlabeled group
 */

import type { CvSectionId } from "@/lib/cv/schema";

import type { PolishItem } from "./polish-reducer";

export interface PolishItemGroup {
  /** Stable accordion value; "" for the single flat group. */
  key: string;
  /**
   * RHF paths whose current values compose the group label (e.g. org +
   * project title); empty for flat sections — no group header is rendered.
   */
  labelPaths: string[];
  items: PolishItem[];
}

const EXPERIENCE_PATH = /^(experience\.\d+\.projects\.\d+)\.bullets\.\d+\.body$/;
const ENTRY_PATH = /^(education|research)\.(\d+)\.bullets\.\d+\.body$/;

function groupKeyOf(item: PolishItem): { key: string; labelPaths: string[] } {
  const experience = EXPERIENCE_PATH.exec(item.path);
  if (experience) {
    return {
      key: experience[1],
      labelPaths: [
        // experience.{company}.org + experience.{company}.projects.{project}.title
        experience[1].replace(/\.projects\.\d+$/, ".org"),
        `${experience[1]}.title`,
      ],
    };
  }
  const entry = ENTRY_PATH.exec(item.path);
  if (entry) {
    const [, section, index] = entry;
    const prefix = `${section}.${index}`;
    return {
      key: prefix,
      labelPaths:
        section === "education"
          ? [`${prefix}.org`, `${prefix}.title`]
          : [`${prefix}.title`],
    };
  }
  return { key: "", labelPaths: [] };
}

/**
 * Group items in document order. A flat section (or an item/entry scope)
 * yields exactly one group; nested sections at group/section granularity
 * yield one preview group per entry.
 */
export function groupPolishItems(
  items: ReadonlyArray<PolishItem>,
  sectionId: CvSectionId,
): PolishItemGroup[] {
  if (sectionId === "profile" || sectionId === "skills" || sectionId === "additional") {
    return items.length > 0 ? [{ key: "", labelPaths: [], items: [...items] }] : [];
  }
  const groups: PolishItemGroup[] = [];
  const byKey = new Map<string, PolishItemGroup>();
  for (const item of items) {
    const { key, labelPaths } = groupKeyOf(item);
    let group = byKey.get(key);
    if (!group) {
      group = { key, labelPaths, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
