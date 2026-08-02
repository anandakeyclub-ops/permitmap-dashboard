import { describe, it, expect } from 'vitest';
import {
  SEARCH_DEBOUNCE_MS, buildPermitsPath, commitDelayMs, createLatest,
  showPermitEmptyState, showPermitFooter, csvDisabled,
} from '../lib/liveSearch';

describe('buildPermitsPath — query param handling', () => {
  it('omits query entirely for a blank / whitespace query (no-query = unchanged request)', () => {
    expect(buildPermitsPath('marion', 500)).toBe('/permits?county=marion&limit=500');
    expect(buildPermitsPath('marion', 500, '')).toBe('/permits?county=marion&limit=500');
    expect(buildPermitsPath('marion', 500, '   ')).toBe('/permits?county=marion&limit=500');
    expect(buildPermitsPath('marion', 500, null)).toBe('/permits?county=marion&limit=500');
  });

  it('sends a trimmed, URL-encoded query when populated', () => {
    expect(buildPermitsPath('marion', 500, '  generator  ')).toBe('/permits?county=marion&limit=500&query=generator');
    expect(buildPermitsPath('marion', 500, 'a b/c')).toBe('/permits?county=marion&limit=500&query=a%20b%2Fc');
  });

  it('encodes the county too', () => {
    expect(buildPermitsPath('palm beach', 50, 'roof')).toBe('/permits?county=palm%20beach&limit=50&query=roof');
  });
});

describe('commitDelayMs — debounce vs immediate', () => {
  it('commits immediately (0) for a blank/cleared query', () => {
    expect(commitDelayMs('')).toBe(0);
    expect(commitDelayMs('   ')).toBe(0);
  });
  it('debounces a populated query at ~275ms (< 300)', () => {
    expect(commitDelayMs('gen')).toBe(SEARCH_DEBOUNCE_MS);
    expect(SEARCH_DEBOUNCE_MS).toBe(275);
    expect(SEARCH_DEBOUNCE_MS).toBeLessThan(300);
  });
});

describe('createLatest — newest-wins guard', () => {
  it('only the most recent request id is current (stale responses ignored)', () => {
    const l = createLatest();
    const a = l.begin();
    const b = l.begin();
    const c = l.begin();
    expect(l.isCurrent(a)).toBe(false); // superseded
    expect(l.isCurrent(b)).toBe(false); // superseded
    expect(l.isCurrent(c)).toBe(true);  // newest wins
  });
  it('a new request supersedes the previous current', () => {
    const l = createLatest();
    const first = l.begin();
    expect(l.isCurrent(first)).toBe(true);
    const second = l.begin();
    expect(l.isCurrent(first)).toBe(false);
    expect(l.isCurrent(second)).toBe(true);
  });
});

describe('permits-area render gating during load', () => {
  it('empty state is suppressed while loading, shown only after load with 0 results', () => {
    expect(showPermitEmptyState(true, 0)).toBe(false);   // loading → no empty state
    expect(showPermitEmptyState(false, 0)).toBe(true);   // loaded, no results → empty state
    expect(showPermitEmptyState(false, 5)).toBe(false);  // loaded, results → no empty state
  });
  it('footer (Showing X of Y + Load more) is suppressed while loading', () => {
    expect(showPermitFooter(true, 8)).toBe(false);       // loading → no footer (no stale count)
    expect(showPermitFooter(false, 8)).toBe(true);       // loaded with results → footer
    expect(showPermitFooter(false, 0)).toBe(false);      // loaded, no results → no footer
  });
  it('CSV export is disabled while loading and when there are no results', () => {
    expect(csvDisabled(true, 8)).toBe(true);             // loading → disabled (never export stale)
    expect(csvDisabled(false, 0)).toBe(true);            // no results → disabled
    expect(csvDisabled(false, 8)).toBe(false);           // loaded with results → enabled
  });
});
