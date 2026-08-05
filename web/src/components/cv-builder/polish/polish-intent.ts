/**
 * Pending polish intent (unit 3.5, optional restore-after-sign-in).
 *
 * Clicking a polish entry while signed out stashes the scope in
 * sessionStorage and opens the auth modal. When a session appears (form
 * sign-in, or an OAuth redirect round-trip — sessionStorage survives it in
 * the same tab), the wiring re-opens the dialog with the stashed scope so
 * the user lands where they intended.
 *
 * Safety rails:
 * - single-use: the intent is consumed (cleared) on the first read, whatever
 *   the outcome — a stale intent can never pop a dialog twice;
 * - bound to the document it was stashed for: switching documents discards it;
 * - short TTL: an intent older than PENDING_POLISH_INTENT_TTL_MS is
 *   discarded, so signing in much later does not resurrect a forgotten flow;
 * - structurally validated on read: sessionStorage is local data, but the
 *   scope feeds request assembly, so anything off-shape is dropped (the
 *   scope builder re-validates downstream regardless).
 *
 * Storage is injectable for tests; the default is window.sessionStorage and
 * every failure mode (SSR, blocked storage, quota) degrades to "no restore".
 */

import { ORDERED_SECTION_IDS, type CvSectionId } from "@/lib/cv/schema";
import { POLISH_GRANULARITIES } from "@/lib/polish/contract";

import type { PolishScope } from "./scope-builder";

export const PENDING_POLISH_INTENT_KEY = "typst-cv-builder:polish:pending-intent";
export const PENDING_POLISH_INTENT_TTL_MS = 10 * 60 * 1000;
/** createdAt this far in the future is treated as clock skew, not a valid intent. */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

export interface PendingPolishIntent {
  documentId: string;
  scope: PolishScope;
  /** Epoch milliseconds when the entry was clicked. */
  createdAt: number;
}

/** Minimal storage surface; satisfied by window.sessionStorage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function savePendingPolishIntent(
  intent: PendingPolishIntent,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PENDING_POLISH_INTENT_KEY, JSON.stringify(intent));
  } catch {
    // Blocked/full storage: the sign-in guidance still works, only the
    // restore is lost — acceptable degradation.
  }
}

export function clearPendingPolishIntent(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(PENDING_POLISH_INTENT_KEY);
  } catch {
    // ignore
  }
}

const SCOPE_ID_PATTERN = /^\d+(\.\d+)*$/;

function isPolishScope(value: unknown): value is PolishScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  if (!ORDERED_SECTION_IDS.includes(scope.sectionId as CvSectionId)) return false;
  if (!POLISH_GRANULARITIES.includes(scope.granularity as PolishScope["granularity"])) {
    return false;
  }
  if (scope.entryId !== undefined) {
    if (typeof scope.entryId !== "string" || !SCOPE_ID_PATTERN.test(scope.entryId)) return false;
  }
  if (scope.groupId !== undefined) {
    if (typeof scope.groupId !== "string" || !SCOPE_ID_PATTERN.test(scope.groupId)) return false;
  }
  if (scope.itemId !== undefined) {
    if (typeof scope.itemId !== "string" || !SCOPE_ID_PATTERN.test(scope.itemId)) return false;
  }
  return true;
}

function isPendingPolishIntent(value: unknown): value is PendingPolishIntent {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as Record<string, unknown>;
  return (
    typeof intent.documentId === "string" &&
    typeof intent.createdAt === "number" &&
    Number.isFinite(intent.createdAt) &&
    isPolishScope(intent.scope)
  );
}

export interface TakePendingPolishIntentOptions {
  now?: number;
  ttlMs?: number;
  storage?: StorageLike | null;
}

/**
 * Read and consume the pending intent for `documentId`. Returns the scope to
 * re-open, or null when there is nothing valid to restore. The stored value
 * is always cleared — the intent is single-use.
 */
export function takePendingPolishIntent(
  documentId: string,
  options: TakePendingPolishIntentOptions = {},
): PolishScope | null {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return null;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? PENDING_POLISH_INTENT_TTL_MS;

  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_POLISH_INTENT_KEY);
  } catch {
    return null;
  }
  clearPendingPolishIntent(storage);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingPolishIntent(parsed)) return null;
    if (parsed.documentId !== documentId) return null;
    if (parsed.createdAt > now + CLOCK_SKEW_TOLERANCE_MS) return null;
    if (now - parsed.createdAt > ttlMs) return null;
    return parsed.scope;
  } catch {
    return null;
  }
}
