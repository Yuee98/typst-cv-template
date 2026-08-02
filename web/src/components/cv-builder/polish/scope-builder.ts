/**
 * Scope builder for the AI polish flow.
 *
 * Turns a UI scope ({ sectionId, granularity, entryId?, itemId? }) plus the
 * current form data into one immutable snapshot:
 *
 *   { documentId, targets, referencePaths, apiRequest, disclosure }
 *
 * - targets carry the react-hook-form field `path` for local write-back and
 *   the stale guard; paths NEVER leave the client (apiRequest contains only
 *   opaque ids). `PolishTarget` is defined once in polish-reducer.ts (CP0b)
 *   and re-exported here; `PolishSnapshot` extends the reducer's
 *   `PolishSnapshotBase`, so the dialog reducer consumes snapshots as-is.
 * - apiRequest is the exact POST /api/polish body and always validates
 *   against polishRequestSchema. `clientRequestId` is parameter-injected:
 *   the caller mints it with crypto.randomUUID() per "confirm polish" (a
 *   rerun mints a fresh one); the builder never generates it.
 * - disclosure is the human-readable summary of exactly what will be sent to
 *   the third-party AI service, derived from the SAME filtered content as
 *   apiRequest (roadmap: disclosure 与真实请求必须来自同一 snapshot).
 *
 * Aggregate filtering (roadmap, one rule shared by the single-item disable
 * and aggregate scopes): blank or < MIN_POLISHABLE_TEXT_CHARS items are
 * excluded; if nothing survives, the scope is not submittable and the caller
 * disables the confirm button. References never repeat a target text;
 * disclosure is computed after filtering.
 *
 * Scope ids (`entryId`/`itemId`) are dot-separated zero-based index paths
 * inside the section, mirroring the form structure (CvData items carry no
 * stable ids of their own):
 * - profile / skills / additional: itemId "<item>"
 * - experience: entryId "<company>.<project>", itemId "<company>.<project>.<bullet>"
 * - education / research: entryId "<entry>", itemId "<entry>.<bullet>"
 * Ids the granularity does not need are ignored; profile "entry" granularity
 * means the whole profile (its entry-level == section-level per the
 * capability matrix).
 */

import type { CvData, CvSectionId } from "@/lib/cv/schema";
import {
  getSectionCapability,
  MAX_ITEM_CHARS,
  MAX_ITEMS,
  MAX_REFERENCE_CHARS,
  MAX_REFERENCE_ITEM_CHARS,
  MAX_REFERENCES,
  MAX_STYLE_INSTRUCTION_CHARS,
  MAX_TARGET_CHARS,
  polishRequestSchema,
  type PolishableSectionId,
  type PolishContextLevel,
  type PolishGranularity,
  type PolishLanguage,
  type PolishReferenceRole,
  type PolishRequest,
  type PolishStylePreset,
} from "@/lib/polish/contract";

import type { PolishSnapshotBase, PolishTarget } from "./polish-reducer";

export type { PolishTarget } from "./polish-reducer";

/** Minimum meaningful length of a polishable text (roadmap aggregate filter). */
export const MIN_POLISHABLE_TEXT_CHARS = 10;

/**
 * Single source for both the single-item button disable rule and the
 * aggregate scope filter: whitespace-only or shorter than
 * MIN_POLISHABLE_TEXT_CHARS after trimming is not polishable. The stored
 * text itself is never trimmed.
 */
export function isPolishableText(text: string): boolean {
  return text.trim().length >= MIN_POLISHABLE_TEXT_CHARS;
}

export interface PolishScope {
  sectionId: CvSectionId;
  granularity: PolishGranularity;
  entryId?: string;
  itemId?: string;
}

/**
 * One polish target inside a snapshot. `path` is the react-hook-form field
 * path used for local write-back and the stale guard; it must never be sent
 * to the server — only the opaque `id` leaves the client. The single type
 * definition lives in polish-reducer.ts and is re-exported above.
 */

/** Human-readable account of exactly what leaves the device. */
export interface PolishDisclosure {
  /** Filtered targets that will be sent (same texts as apiRequest.items). */
  targets: ReadonlyArray<{ id: string; text: string }>;
  /** Context references that will be sent (same texts as apiRequest.context.references). */
  references: ReadonlyArray<{ role: PolishReferenceRole; label?: string; text: string }>;
  /** Style options that will be sent, when set. */
  stylePreset?: PolishStylePreset;
  styleInstruction?: string;
  totalTargetChars: number;
  /**
   * Aggregate reference size counting text AND label per reference — the same
   * accounting as the contract's MAX_REFERENCE_CHARS check (labels are prompt
   * content too), so the displayed count matches the enforced budget.
   */
  totalReferenceChars: number;
}

export interface PolishSnapshot extends PolishSnapshotBase {
  /**
   * Form paths every sent reference text was sourced from. Together with the
   * target paths this is the input of the stale guard: if any of these fields
   * changes underneath (e.g. cloud sync), the snapshot is invalidated.
   */
  referencePaths: string[];
  /** Exact POST /api/polish body; validates against polishRequestSchema. */
  apiRequest: PolishRequest;
  disclosure: PolishDisclosure;
}

export type PolishScopeFailureCode =
  /** Section is not polishable at all (publications). */
  | "section_not_polishable"
  /** Granularity not offered for this section by the capability matrix. */
  | "granularity_not_supported"
  /** Missing/malformed/out-of-bounds entryId or itemId. */
  | "invalid_scope"
  /** Nothing left after the aggregate filter (all blank/short). */
  | "no_targets"
  /** More targets than MAX_ITEMS. */
  | "too_many_targets"
  /** A target over MAX_ITEM_CHARS, or the total over MAX_TARGET_CHARS. */
  | "targets_too_large"
  /** More references than MAX_REFERENCES, or the text+label total over MAX_REFERENCE_CHARS. */
  | "references_too_large"
  /** styleInstruction over MAX_STYLE_INSTRUCTION_CHARS after trimming. */
  | "style_instruction_too_long"
  /** Final contract self-check failed; unreachable by construction. */
  | "invalid_request";

export type BuildPolishSnapshotResult =
  | { ok: true; snapshot: PolishSnapshot }
  | { ok: false; code: PolishScopeFailureCode };

export interface BuildPolishSnapshotInput {
  documentId: string;
  cv: CvData;
  /** Output language; also localizes the reference labels sent to the model. */
  language: PolishLanguage;
  scope: PolishScope;
  level: PolishContextLevel;
  stylePreset?: PolishStylePreset;
  styleInstruction?: string;
  /**
   * Dedup key minted by the caller at confirm time (crypto.randomUUID()).
   * Never generated here: a snapshot built for the config-phase disclosure
   * display carries a throwaway id; the request fired at confirm time must
   * carry the id the dialog dispatched with CONFIRM.
   */
  clientRequestId: string;
}

// ---------------------------------------------------------------------------
// Reference labels (sent to the model; localized via the request language)
// ---------------------------------------------------------------------------

type MetadataLabelKey =
  | "company"
  | "project"
  | "projectDetail"
  | "organization"
  | "title"
  | "detail"
  | "date"
  | "category";

const METADATA_LABELS: Record<PolishLanguage, Record<MetadataLabelKey, string>> = {
  en: {
    company: "Company",
    project: "Project",
    projectDetail: "Project detail",
    organization: "Organization",
    title: "Title",
    detail: "Detail",
    date: "Date",
    category: "Category",
  },
  zh: {
    company: "公司",
    project: "项目",
    projectDetail: "项目详情",
    organization: "机构",
    title: "名称",
    detail: "详情",
    date: "日期",
    category: "类别",
  },
};

const LEVEL2_LABELS: Record<PolishLanguage, { profile: string; skill: string }> = {
  en: { profile: "Profile", skill: "Skill" },
  zh: { profile: "个人简介", skill: "技能" },
};

// ---------------------------------------------------------------------------
// Section traversal: locate every polishable item with its entry context
// ---------------------------------------------------------------------------

interface SourcedText {
  path: string;
  labelKey: MetadataLabelKey;
  text: string;
}

interface EntryContext {
  /** Unique per entry within the section (dot-joined index path). */
  key: string;
  /** Container one level up: the company for experience, "" (section) otherwise. */
  parentKey: string;
  /** Fact fields offered as scope_metadata context (never polish targets). */
  metadata: SourcedText[];
}

interface LocatedItem {
  /** RHF field path of the item's text field. */
  path: string;
  text: string;
  /** Zero-based index path of this item inside the section. */
  indexPath: number[];
  entry: EntryContext;
  /** Items sharing this key are level-1 siblings of an item-granularity scope. */
  siblingKey: string;
}

function listSectionItems(cv: CvData, sectionId: PolishableSectionId): LocatedItem[] {
  switch (sectionId) {
    case "profile":
      return cv.profile.map((item, index) => ({
        path: `profile.${index}.body`,
        text: item.body,
        indexPath: [index],
        entry: { key: `${index}`, parentKey: "", metadata: [] },
        siblingKey: "",
      }));
    case "skills":
    case "additional": {
      // `label` is context only (capability matrix); the body is the target.
      return cv[sectionId].map((item, index) => ({
        path: `${sectionId}.${index}.body`,
        text: item.body,
        indexPath: [index],
        entry: {
          key: `${index}`,
          parentKey: "",
          metadata: [
            { path: `${sectionId}.${index}.label`, labelKey: "category", text: item.label },
          ],
        },
        siblingKey: "",
      }));
    }
    case "experience":
      return cv.experience.flatMap((company, companyIndex) =>
        company.projects.flatMap((project, projectIndex) => {
          const entry: EntryContext = {
            key: `${companyIndex}.${projectIndex}`,
            parentKey: `${companyIndex}`,
            metadata: [
              {
                path: `experience.${companyIndex}.org`,
                labelKey: "company",
                text: company.org,
              },
              {
                path: `experience.${companyIndex}.projects.${projectIndex}.title`,
                labelKey: "project",
                text: project.title,
              },
              {
                path: `experience.${companyIndex}.projects.${projectIndex}.detail`,
                labelKey: "projectDetail",
                text: project.detail,
              },
            ],
          };
          return project.bullets.map((bullet, bulletIndex) => ({
            path: `experience.${companyIndex}.projects.${projectIndex}.bullets.${bulletIndex}.body`,
            text: bullet.body,
            indexPath: [companyIndex, projectIndex, bulletIndex],
            entry,
            siblingKey: entry.key,
          }));
        }),
      );
    case "education":
      return cv.education.flatMap((entry, entryIndex) => {
        const entryContext: EntryContext = {
          key: `${entryIndex}`,
          parentKey: "",
          metadata: [
            {
              path: `education.${entryIndex}.org`,
              labelKey: "organization",
              text: entry.org,
            },
            {
              path: `education.${entryIndex}.title`,
              labelKey: "title",
              text: entry.title,
            },
            {
              path: `education.${entryIndex}.detail`,
              labelKey: "detail",
              text: entry.detail,
            },
          ],
        };
        return entry.bullets.map((bullet, bulletIndex) => ({
          path: `education.${entryIndex}.bullets.${bulletIndex}.body`,
          text: bullet.body,
          indexPath: [entryIndex, bulletIndex],
          entry: entryContext,
          siblingKey: entryContext.key,
        }));
      });
    case "research":
      return cv.research.flatMap((entry, entryIndex) => {
        const entryContext: EntryContext = {
          key: `${entryIndex}`,
          parentKey: "",
          metadata: [
            {
              path: `research.${entryIndex}.title`,
              labelKey: "title",
              text: entry.title,
            },
            {
              path: `research.${entryIndex}.date`,
              labelKey: "date",
              text: entry.date,
            },
          ],
        };
        return entry.bullets.map((bullet, bulletIndex) => ({
          path: `research.${entryIndex}.bullets.${bulletIndex}.body`,
          text: bullet.body,
          indexPath: [entryIndex, bulletIndex],
          entry: entryContext,
          siblingKey: entryContext.key,
        }));
      });
  }
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

function parseIndexPath(id: string): number[] | null {
  if (!/^\d+(\.\d+)*$/.test(id)) return null;
  return id.split(".").map(Number);
}

/** Items selected by the scope, in document order; null when the scope does not resolve. */
function selectScopeItems(all: LocatedItem[], scope: PolishScope): LocatedItem[] | null {
  switch (scope.granularity) {
    case "section":
      return all;
    case "entry": {
      // Flat sections (profile) have a single virtual entry: entry-level
      // means the whole list and entryId is neither needed nor used.
      if (all.every((item) => item.indexPath.length === 1)) return all;
      if (scope.entryId === undefined) return null;
      const entryPath = parseIndexPath(scope.entryId);
      if (!entryPath) return null;
      // An entry's items live exactly one index level below the entry path.
      const selected = all.filter(
        (item) =>
          item.indexPath.length === entryPath.length + 1 &&
          entryPath.every((value, index) => item.indexPath[index] === value),
      );
      return selected.length > 0 ? selected : null;
    }
    case "item": {
      if (scope.itemId === undefined) return null;
      const itemPath = parseIndexPath(scope.itemId);
      if (!itemPath) return null;
      const selected = all.filter(
        (item) =>
          item.indexPath.length === itemPath.length &&
          item.indexPath.every((value, index) => value === itemPath[index]),
      );
      return selected.length > 0 ? selected : null;
    }
  }
}

/** Distinct entries that contributed a (filtered) target, in document order. */
function metadataEntriesOf(targets: LocatedItem[]): EntryContext[] {
  const seen = new Set<string>();
  const entries: EntryContext[] = [];
  for (const target of targets) {
    if (!seen.has(target.entry.key)) {
      seen.add(target.entry.key);
      entries.push(target.entry);
    }
  }
  return entries;
}

/**
 * Level-1 siblings (roadmap「同 project/section 兄弟条目」):
 * - item granularity: non-target items in the same entry (nested sections)
 *   or the same flat list (profile/skills/additional)
 * - entry granularity: non-target items of sibling entries in the same
 *   parent container (same company for experience, same section otherwise)
 * - section granularity: none — every sibling is already a target
 */
function siblingItemsOf(
  all: LocatedItem[],
  targets: LocatedItem[],
  granularity: PolishGranularity,
): LocatedItem[] {
  if (granularity === "section" || targets.length === 0) return [];
  const targetSet = new Set(targets);
  const anchor = targets[0];
  if (granularity === "item") {
    return all.filter((item) => item.siblingKey === anchor.siblingKey && !targetSet.has(item));
  }
  return all.filter(
    (item) =>
      item.entry.parentKey === anchor.entry.parentKey &&
      item.entry.key !== anchor.entry.key &&
      !targetSet.has(item),
  );
}

// ---------------------------------------------------------------------------
// Reference assembly (context levels)
// ---------------------------------------------------------------------------

interface SourcedReference {
  path: string;
  role: PolishReferenceRole;
  label?: string;
  text: string;
}

/**
 * Level 0 sends no references. Level 1 adds scope metadata and siblings.
 * Level 2 adds the profile summary and skill tags (header PII is never
 * read). The server re-trims by level and does not trust the client.
 */
function assembleReferences(
  cv: CvData,
  granularity: PolishGranularity,
  level: PolishContextLevel,
  all: LocatedItem[],
  targets: LocatedItem[],
  language: PolishLanguage,
): SourcedReference[] {
  if (level === 0) return [];
  const labels = METADATA_LABELS[language];
  const references: SourcedReference[] = [];

  for (const entry of metadataEntriesOf(targets)) {
    for (const metadata of entry.metadata) {
      references.push({
        path: metadata.path,
        role: "scope_metadata",
        label: labels[metadata.labelKey],
        text: metadata.text,
      });
    }
  }

  for (const sibling of siblingItemsOf(all, targets, granularity)) {
    references.push({ path: sibling.path, role: "sibling", text: sibling.text });
  }

  if (level === 2) {
    cv.profile.forEach((item, index) => {
      references.push({
        path: `profile.${index}.body`,
        role: "profile",
        label: LEVEL2_LABELS[language].profile,
        text: item.body,
      });
    });
    cv.skills.forEach((item, index) => {
      references.push({
        path: `skills.${index}.label`,
        role: "skill",
        label: LEVEL2_LABELS[language].skill,
        text: item.label,
      });
    });
  }

  return references;
}

/**
 * Eligibility and dedup for references: blank texts are dropped; oversized
 * context is dropped rather than truncated; a reference never repeats a
 * (filtered) target text; duplicates among references keep first occurrence.
 */
function finalizeReferences(
  references: SourcedReference[],
  targetTexts: ReadonlySet<string>,
): SourcedReference[] {
  const seen = new Set<string>();
  const finalized: SourcedReference[] = [];
  for (const reference of references) {
    if (reference.text.trim().length === 0) continue;
    if (reference.text.length > MAX_REFERENCE_ITEM_CHARS) continue;
    if (targetTexts.has(reference.text)) continue;
    if (seen.has(reference.text)) continue;
    seen.add(reference.text);
    finalized.push(reference);
  }
  return finalized;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the unified polish snapshot for a scope. Returns a discriminated
 * union: `ok: false` carries a machine-readable code the caller maps to a
 * disabled button or an explanatory message; no exception is ever thrown
 * for ordinary bad input.
 */
export function buildPolishSnapshot(input: BuildPolishSnapshotInput): BuildPolishSnapshotResult {
  const { scope } = input;
  const capability = getSectionCapability(scope.sectionId);
  if (!capability) return { ok: false, code: "section_not_polishable" };
  if (!capability.granularities.includes(scope.granularity)) {
    return { ok: false, code: "granularity_not_supported" };
  }
  // A defined capability proves the section is polishable; the contract type
  // cannot express that narrowing on CvSectionId.
  const sectionId = scope.sectionId as PolishableSectionId;

  const styleInstruction = input.styleInstruction?.trim();
  if (styleInstruction !== undefined && styleInstruction.length > MAX_STYLE_INSTRUCTION_CHARS) {
    return { ok: false, code: "style_instruction_too_long" };
  }

  const all = listSectionItems(input.cv, sectionId);
  const selected = selectScopeItems(all, scope);
  if (!selected) return { ok: false, code: "invalid_scope" };

  // Aggregate filter — the same rule as the single-item disable.
  const filtered = selected.filter((item) => isPolishableText(item.text));
  if (filtered.length === 0) return { ok: false, code: "no_targets" };
  if (filtered.length > MAX_ITEMS) return { ok: false, code: "too_many_targets" };
  if (filtered.some((item) => item.text.length > MAX_ITEM_CHARS)) {
    return { ok: false, code: "targets_too_large" };
  }
  const totalTargetChars = filtered.reduce((sum, item) => sum + item.text.length, 0);
  if (totalTargetChars > MAX_TARGET_CHARS) return { ok: false, code: "targets_too_large" };

  // Opaque sequential ids (`i0`…), deterministic for a given snapshot build.
  const targets: PolishTarget[] = filtered.map((item, index) => ({
    id: `i${index}`,
    path: item.path,
    text: item.text,
  }));

  const references = finalizeReferences(
    assembleReferences(input.cv, scope.granularity, input.level, all, filtered, input.language),
    new Set(filtered.map((item) => item.text)),
  );
  if (references.length > MAX_REFERENCES) return { ok: false, code: "references_too_large" };
  // Labels count toward the aggregate, exactly like the contract's
  // MAX_REFERENCE_CHARS check — the pre-check must trip the same failure code
  // the final self-check would, never fall through to `invalid_request`.
  const totalReferenceChars = references.reduce(
    (sum, reference) => sum + reference.text.length + (reference.label?.length ?? 0),
    0,
  );
  if (totalReferenceChars > MAX_REFERENCE_CHARS) {
    return { ok: false, code: "references_too_large" };
  }

  const apiRequest: PolishRequest = {
    clientRequestId: input.clientRequestId,
    granularity: scope.granularity,
    sectionId: scope.sectionId,
    language: input.language,
    items: targets.map(({ id, text }) => ({ id, kind: capability.kind, text })),
    context: {
      level: input.level,
      references: references.map(({ role, label, text }) => ({ role, label, text })),
    },
    ...(input.stylePreset !== undefined ? { stylePreset: input.stylePreset } : {}),
    ...(styleInstruction ? { styleInstruction } : {}),
  };

  // Structural guarantee that the built request satisfies the shared contract
  // including cross-field rules; every reachable failure has its own code above.
  const parsed = polishRequestSchema.safeParse(apiRequest);
  if (!parsed.success) return { ok: false, code: "invalid_request" };

  const snapshot: PolishSnapshot = {
    documentId: input.documentId,
    targets,
    referencePaths: [...new Set(references.map((reference) => reference.path))],
    apiRequest,
    disclosure: {
      targets: targets.map(({ id, text }) => ({ id, text })),
      references: references.map(({ role, label, text }) => ({ role, label, text })),
      ...(input.stylePreset !== undefined ? { stylePreset: input.stylePreset } : {}),
      ...(styleInstruction ? { styleInstruction } : {}),
      totalTargetChars,
      totalReferenceChars,
    },
  };
  return { ok: true, snapshot };
}
