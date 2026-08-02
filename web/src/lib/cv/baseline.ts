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
 */

export type CvBaseline = {
  documentId: string;
  hash: string;
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

/**
 * Hashes CV data to a compact, deterministic fingerprint (cyrb53 over the
 * stable serialization). Two structurally equal values always hash equal;
 * any structural difference changes the hash.
 */
export function hashCvBaseline(data: CvData): string {
  const serialized = stableSerializeCvData(data);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < serialized.length; i++) {
    const ch = serialized.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Captures the persisted state of a document as the dirty-check baseline.
 * `data` must be the data as persisted (or as last loaded from a storage
 * backend), not an unsaved in-memory variant.
 */
export function createCvBaseline(documentId: string, data: CvData): CvBaseline {
  return { documentId, hash: hashCvBaseline(data) };
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

  return baseline.hash === hashCvBaseline(data);
}
