// Pure helpers for the dashboard's server-side live search. No React, no fetch — the Permits tab
// wires these into a debounce effect + an AbortController'd /permits fetch, so the URL shape, the
// debounce/immediate decision, the newest-wins guard, and the loading-gating are defined (and
// tested) in ONE place. Keyword filtering now happens server-side (GET /permits?query=…); the
// client only does trade filter + sort over the returned set.

// Live-search debounce: fire ~275 ms after the user stops typing. Deliberately < 300 ms so search
// feels immediate (Enter and clearing bypass this entirely).
export const SEARCH_DEBOUNCE_MS = 275;

/**
 * Build the /permits request path. A blank / whitespace-only query OMITS the `query` param entirely
 * (identical to the pre-search request, so no-query behavior is unchanged); otherwise the query is
 * trimmed and URL-encoded. County is always encoded.
 */
export function buildPermitsPath(county: string, limit: number, query?: string | null): string {
  let path = `/permits?county=${encodeURIComponent(county)}&limit=${limit}`;
  const q = (query || '').trim();
  if (q) path += `&query=${encodeURIComponent(q)}`;
  return path;
}

/**
 * How long to wait before committing a typed query. Blank/cleared → 0 (commit immediately, so
 * clearing the box instantly reloads the unfiltered list); non-blank → the debounce interval.
 * (Pressing Enter commits immediately regardless — the component calls the commit directly.)
 */
export function commitDelayMs(query: string): number {
  return query.trim() === '' ? 0 : SEARCH_DEBOUNCE_MS;
}

/**
 * Newest-wins guard. Each request calls begin() for a monotonically increasing id; only the most
 * recent id is "current", so a stale response that resolves late is ignored. Pairs with an
 * AbortController (which cancels the in-flight request); this guards the already-resolved case.
 */
export function createLatest(): { begin(): number; isCurrent(id: number): boolean } {
  let current = 0;
  return {
    begin() { return ++current; },
    isCurrent(id: number) { return id === current; },
  };
}

// ── Permits-area render gating (search loading). While a request is in flight we hide stale rows,
//    the empty state, the footer (Showing X of Y + Load more), and disable CSV export. ────────────

/** Empty state ("No permits match…") shows only after loading completes with zero results. */
export function showPermitEmptyState(permitsLoading: boolean, displayedCount: number): boolean {
  return !permitsLoading && displayedCount === 0;
}

/** The footer row (Showing X of Y + Load more) shows only after loading, with results present. */
export function showPermitFooter(permitsLoading: boolean, displayedCount: number): boolean {
  return !permitsLoading && displayedCount > 0;
}

/** CSV export is disabled while loading (never export stale rows) and when there are no results. */
export function csvDisabled(permitsLoading: boolean, displayedCount: number): boolean {
  return permitsLoading || displayedCount === 0;
}
