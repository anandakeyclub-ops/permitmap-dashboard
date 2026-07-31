// Focus-trap helpers for the dashboard dialogs (PermitDrawer, ContractorProfile, UpgradeModal).
// No dependency, no framework — the pure wrap logic is unit-testable; the DOM query is a thin,
// code-reviewed glue used by each dialog's existing keydown effect.

// Standard focusable selector; excludes disabled controls and tabindex="-1".
export const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Visible, enabled, focusable descendants of `container`, in DOM order. DOM-dependent (browser
 *  only) — not exercised by the pure unit tests. Filters out hidden and aria-hidden elements. */
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const els = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return els.filter(el =>
    !el.hasAttribute('disabled') &&
    el.getAttribute('aria-hidden') !== 'true' &&
    // visible: has layout boxes (offsetParent is null for display:none; getClientRects covers fixed)
    (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0),
  );
}

/**
 * Pure Tab-wrap decision. Given the focusable count, the index of the currently-focused element
 * within that list (`-1` if focus is outside/unknown), and whether Shift is held, return the index
 * to move focus to (caller preventDefaults + focuses it), or `-1` to allow the browser's native Tab
 * (i.e. focus is mid-list and should move normally).
 *
 * - 0 focusable  → -1 (caller keeps focus on the panel itself)
 * - 1 focusable  → 0  (can never leave that single control)
 * - forward at last → wrap to first; backward at first → wrap to last
 * - focus escaped (activeIndex === -1) → pull to first (forward) / last (backward)
 */
export function nextTrapIndex(count: number, activeIndex: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  const last = count - 1;
  if (activeIndex === -1) return shiftKey ? last : 0;
  if (shiftKey) return activeIndex === 0 ? last : -1;
  return activeIndex === last ? 0 : -1;
}

/**
 * Apply the focus trap for a Tab keydown within `container`. Wraps at the edges, keeps focus on the
 * panel when there are no focusable children, and pulls focus back if it escaped. Safe no-op for
 * non-Tab keys or a null container. Guards `document.activeElement`.
 */
export function handleDialogTab(container: HTMLElement | null, e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !container) return;
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) {
    e.preventDefault();
    container.focus();
    return;
  }
  const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
  const activeIndex = active ? focusables.indexOf(active) : -1;
  const target = nextTrapIndex(focusables.length, activeIndex, e.shiftKey);
  if (target >= 0) {
    e.preventDefault();
    focusables[target].focus();
  }
}
