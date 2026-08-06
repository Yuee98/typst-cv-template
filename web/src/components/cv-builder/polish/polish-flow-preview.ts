import type { PolishLanguage } from "@/lib/polish/contract";

import {
  planWriteBack,
  checkWriteBack,
  isSnapshotStale,
  type SnapshotPathValues,
  type WriteBackPlan,
} from "./stale-guard";
import type { PolishItem, PolishItemStatus } from "./polish-reducer";
import type { PolishSnapshot } from "./scope-builder";

export type PreviewTransitionAction =
  | "ACCEPT_ITEM"
  | "REJECT_ITEM"
  | "UNDO_ACCEPT_ITEM"
  | "UNDO_REJECT_ITEM";

export interface PreviewTransitionAssessment {
  plan: WriteBackPlan;
  /** A rejected/pending transition never writes and needs no identity guard. */
  needsIdentityGuard: boolean;
  documentStale: boolean;
  languageDrifted: boolean;
  referencesDrifted: boolean;
  fieldDrifted: boolean;
}

interface PreviewTransitionInput {
  item: PolishItem;
  next: PolishItemStatus;
  snapshot: PolishSnapshot | null;
  documentId: string | null;
  language: PolishLanguage;
  baselinePathValues: SnapshotPathValues;
  getValue: (path: string) => unknown;
}

/**
 * Evaluate the guards for one preview transition.  The caller remains the
 * owner of all state writes and reducer dispatches; this pure assessment
 * keeps the effect-tiered barrier rules in one task-shaped module.
 */
export function assessPreviewTransition({
  item,
  next,
  snapshot,
  documentId,
  language,
  baselinePathValues,
  getValue,
}: PreviewTransitionInput): PreviewTransitionAssessment {
  const plan = planWriteBack(item, next);
  const needsIdentityGuard = plan.write;
  const intoAccepted = next === "accepted";
  const documentStale = !snapshot || !documentId || documentId !== snapshot.documentId;
  const languageDrifted =
    intoAccepted && (!snapshot || language !== snapshot.apiRequest.language);
  const referencesDrifted =
    intoAccepted &&
    isSnapshotStale(baselinePathValues, getValue, snapshot?.referencePaths ?? []);
  const fieldDrifted = needsIdentityGuard && !checkWriteBack(plan, getValue(item.path)).ok;

  return {
    plan,
    needsIdentityGuard,
    documentStale,
    languageDrifted,
    referencesDrifted,
    fieldDrifted,
  };
}

export function hasIdentityStaleTransition(assessment: PreviewTransitionAssessment): boolean {
  return (
    assessment.needsIdentityGuard &&
    (assessment.documentStale ||
      assessment.languageDrifted ||
      assessment.referencesDrifted ||
      assessment.fieldDrifted)
  );
}

export { checkWriteBack, isSnapshotStale, planWriteBack };
