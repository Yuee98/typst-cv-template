import type { CvData } from "./schema";

/**
 * Persisted-data baseline used to derive the CV editor's dirty state.
 *
 * Instead of flipping a boolean to true on any form change, the dirty flag is
 * computed by comparing the current form data against the last persisted
 * snapshot ("baseline") of the *same* document. The baseline is only updated
 * when data is loaded from a storage backend or successfully written to one,
 * so it always reflects what is actually persisted — never an intermediate
 * in-memory state (e.g. a recovered draft).
 *
 * The baseline stores the canonical serialization of the persisted data and
 * comparisons are exact string comparisons, so there is no hash-collision
 * risk to reason about.
 */

export type CvBaseline = {
  documentId: string;
  serialized: string;
};

function sortKeysRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysRecursively);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
        .map(([key, nestedValue]) => [key, sortKeysRecursively(nestedValue)]),
    );
  }

  return value;
}

/**
 * Serializes CV data deterministically: object keys are sorted recursively so
 * two structurally equal values always produce the same string, regardless of
 * key insertion order. Array order is preserved (it is semantically
 * meaningful, e.g. bullet order).
 */
export function stableSerializeCvData(data: CvData): string {
  return JSON.stringify(sortKeysRecursively(data));
}

/** Exact structural equality for CV data (via the canonical serialization). */
export function sameCvData(a: CvData, b: CvData): boolean {
  return stableSerializeCvData(a) === stableSerializeCvData(b);
}

/**
 * Captures the persisted state of a document as the dirty-check baseline.
 * `data` must be the data as persisted (or as last loaded from a storage
 * backend), not an unsaved in-memory variant.
 */
export function createCvBaseline(documentId: string, data: CvData): CvBaseline {
  return { documentId, serialized: stableSerializeCvData(data) };
}

/**
 * Returns true when `data` matches the persisted baseline of the *same*
 * document. Returns false when no baseline exists or the baseline belongs to
 * a different document, so a stale baseline never leaks across documents.
 */
export function matchesCvBaseline(
  baseline: CvBaseline | null | undefined,
  documentId: string | null | undefined,
  data: CvData,
): boolean {
  if (!baseline || !documentId || baseline.documentId !== documentId) {
    return false;
  }

  return baseline.serialized === stableSerializeCvData(data);
}

/**
 * Computes the baseline and dirty flag for loading data into the form. The
 * baseline tracks what is persisted, which is not always what goes into the
 * form: when a local draft is recovered, the form gets the draft while the
 * baseline stays at the persisted (server) data, so the document reads dirty.
 */
export function baselineOnFormLoad(
  documentId: string,
  data: CvData,
  baselineData: CvData = data,
): { baseline: CvBaseline; dirty: boolean } {
  const baseline = createCvBaseline(documentId, baselineData);
  return { baseline, dirty: !matchesCvBaseline(baseline, documentId, data) };
}

/**
 * Computes the outcome of a successful save. Returns null when the completion
 * must be ignored: the saved document is no longer the active one, or the
 * baseline has already moved to another document (a stale async completion
 * must never rebase the newly active document).
 *
 * `currentData` is the live form data, which may have advanced past
 * `savedData` while the save was in flight — dirty is derived from it, not
 * assumed clean. Pass null when the current form data could not be parsed;
 * an unparseable form is treated as dirty.
 */
export function baselineOnPersisted({
  baseline,
  activeDocumentId,
  savedDocumentId,
  savedData,
  currentData,
}: {
  baseline: CvBaseline | null;
  activeDocumentId: string | null;
  savedDocumentId: string;
  savedData: CvData;
  currentData: CvData | null;
}): { baseline: CvBaseline; dirty: boolean } | null {
  if (activeDocumentId !== savedDocumentId) {
    return null;
  }

  if (baseline !== null && baseline.documentId !== savedDocumentId) {
    return null;
  }

  const nextBaseline = createCvBaseline(savedDocumentId, savedData);
  return {
    baseline: nextBaseline,
    dirty: currentData === null || !matchesCvBaseline(nextBaseline, savedDocumentId, currentData),
  };
}

/**
 * Decides the cloud-draft lifecycle for one debounced edit tick: a dirty form
 * keeps the localStorage draft as a safety net; a form back at the persisted
 * baseline makes the draft redundant, so it is cleared instead of rewritten.
 */
export function cloudDraftTick(
  baseline: CvBaseline | null,
  documentId: string,
  data: CvData,
): { dirty: boolean; action: "save-draft" | "clear-draft" } {
  const dirty = !matchesCvBaseline(baseline, documentId, data);
  return { dirty, action: dirty ? "save-draft" : "clear-draft" };
}

/**
 * A recovered draft that is identical to the persisted (server) data is
 * redundant and should be cleared rather than kept around.
 */
export function isDraftRedundant(draft: CvData | null, persistedData: CvData): boolean {
  return draft !== null && sameCvData(draft, persistedData);
}
