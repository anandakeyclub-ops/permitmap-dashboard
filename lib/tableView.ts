// Pure helpers for the permits table "Load more" view. No React, no storage, no fetch.
// The table renders displayedPermits.slice(0, visibleCount); these compute the shown count,
// the next count on a Load more click, and whether the button should appear. Kept pure so the
// (otherwise React-effect) behavior is unit-testable without a component harness.

export const INITIAL_VISIBLE = 50;
export const LOAD_MORE_STEP = 50;

/** Rows actually shown = min(visibleCount, total). Never exceeds the result length. */
export function shownCount(visibleCount: number, total: number): number {
  return Math.max(0, Math.min(visibleCount, total));
}

/** Load more appears only while some rows remain hidden (X < Y). */
export function shouldShowLoadMore(visibleCount: number, total: number): boolean {
  return shownCount(visibleCount, total) < total;
}

/** Next visible count after a Load more click — grows by `step`, clamped to `total`. */
export function nextVisibleCount(
  visibleCount: number, total: number, step: number = LOAD_MORE_STEP,
): number {
  return Math.min(visibleCount + step, total);
}
