/**
 * Stale-guard primitives for the polish dialog (roadmap「状态相关 stale
 * guard」and「dialog 数据与一致性」).
 *
 * Two independent guards, both evaluated with point-in-time `getValues`
 * reads — never a watch subscription:
 *
 * 1. Whole-snapshot guard (config/loading): the values at every target and
 *    reference path captured when the snapshot was built must still hold at
 *    confirm time and when the response arrives. Any drift (cloud sync, an
 *    external edit) invalidates the snapshot → SNAPSHOT_STALE.
 * 2. Per-item write-back guard (preview): before switching an item's state,
 *    the form value at its path must equal `expectedCurrent(item)` — the
 *    polished text for an already-accepted item, the original otherwise.
 *    Accepted items legitimately changed their own path, which is exactly
 *    why the item-level guard is state-dependent and why the whole-snapshot
 *    guard only applies before the preview phase.
 */

import { expectedCurrent, type PolishItem, type PolishItemStatus } from "./polish-reducer";

/** Paths (and their captured values) a snapshot's validity depends on. */
export type SnapshotPathValues = Readonly<Record<string, unknown>>;

interface SnapshotPaths {
  targets: ReadonlyArray<{ path: string }>;
  referencePaths: ReadonlyArray<string>;
}

/**
 * Capture the current form value of every target and reference path of the
 * snapshot. Call this when (and only when) the snapshot is built; the result
 * is the baseline later staleness checks compare against.
 */
export function captureSnapshotPathValues(
  snapshot: SnapshotPaths,
  getValue: (path: string) => unknown,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const target of snapshot.targets) {
    values[target.path] = getValue(target.path);
  }
  for (const path of snapshot.referencePaths) {
    values[path] = getValue(path);
  }
  return values;
}

/**
 * True when any captured path no longer holds its captured value. Only valid
 * before the preview phase: accepting an item intentionally changes its own
 * target path, so post-accept drift is per-item business (planWriteBack).
 *
 * `onlyPaths` narrows the check (e.g. to reference paths for the in-preview
 * "context changed" hint, where accepted targets would false-positive).
 */
export function isSnapshotStale(
  captured: SnapshotPathValues,
  getValue: (path: string) => unknown,
  onlyPaths?: ReadonlyArray<string>,
): boolean {
  if (onlyPaths !== undefined) {
    return onlyPaths.some((path) => path in captured && getValue(path) !== captured[path]);
  }
  return Object.entries(captured).some(([path, value]) => getValue(path) !== value);
}

/** Write-back plan for one item state transition in the preview phase. */
export interface WriteBackPlan {
  /**
   * Value the form field must hold right now for the transition to be safe
   * (state-dependent: polished for an accepted item, original otherwise).
   */
  expectedBefore: string;
  /** Value to write into the form when `write` is true. */
  value: string;
  /**
   * Whether the transition changes what the form holds: only transitions
   * that flip the accepted flag write — pending ↔ rejected never touches
   * the form.
   */
  write: boolean;
}

export function planWriteBack(
  item: Pick<PolishItem, "state" | "original" | "polished">,
  next: PolishItemStatus,
): WriteBackPlan {
  const expectedBefore = expectedCurrent(item);
  const value = next === "accepted" ? item.polished : item.original;
  return {
    expectedBefore,
    value,
    write: (item.state === "accepted") !== (next === "accepted"),
  };
}

/**
 * Evaluate a planned transition against the live form value. `ok: true`
 * means: write plan.value when plan.write, then dispatch the reducer action.
 * `ok: false` means the field drifted underneath — block the transition and
 * surface the item as stale instead of writing or dispatching.
 */
export function checkWriteBack(
  plan: WriteBackPlan,
  currentValue: unknown,
): { ok: true } | { ok: false; reason: "stale" } {
  return currentValue === plan.expectedBefore
    ? { ok: true }
    : { ok: false, reason: "stale" };
}
