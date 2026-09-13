import { describe, it, expect } from 'vitest';
import { sortPermits, nextSortForColumn, sortIndicatorForColumn } from '../lib/sort';

// Raw permit shape (UPPER_SNAKE), as returned by /permits.
const rows = () => [
  { PERMITNO: 'BLD-2026-00030', FULL_ADDRESS: 'Delta Ave', LAST_ISSUED_DATE: '2026-07-10', FINAL_VALUATION: '$12,000' },
  { PERMITNO: 'BLD-2026-00002', FULL_ADDRESS: 'Alpha St',  LAST_ISSUED_DATE: '2026-07-27', FINAL_VALUATION: '5000' },
  { PERMITNO: 'BLD-2026-00100', FULL_ADDRESS: 'charlie Rd', LAST_ISSUED_DATE: '2026-07-01', FINAL_VALUATION: '$99,500.50' },
];
const nos = (arr: any[]) => arr.map(r => r.PERMITNO);

describe('sortPermits — required options', () => {
  it('newest first (by issue date desc)', () => {
    expect(nos(sortPermits(rows(), 'newest'))).toEqual(['BLD-2026-00002', 'BLD-2026-00030', 'BLD-2026-00100']);
  });
  it('oldest first (by issue date asc)', () => {
    expect(nos(sortPermits(rows(), 'oldest'))).toEqual(['BLD-2026-00100', 'BLD-2026-00030', 'BLD-2026-00002']);
  });
  it('highest valuation (numeric, strips $ and commas)', () => {
    expect(nos(sortPermits(rows(), 'value_desc'))).toEqual(['BLD-2026-00100', 'BLD-2026-00030', 'BLD-2026-00002']);
  });
  it('lowest valuation', () => {
    expect(nos(sortPermits(rows(), 'value_asc'))).toEqual(['BLD-2026-00002', 'BLD-2026-00030', 'BLD-2026-00100']);
  });
  it('permit number A–Z (numeric-aware)', () => {
    expect(nos(sortPermits(rows(), 'permit_asc'))).toEqual(['BLD-2026-00002', 'BLD-2026-00030', 'BLD-2026-00100']);
  });
  it('address A–Z (case-insensitive)', () => {
    expect(sortPermits(rows(), 'address_asc').map(r => r.FULL_ADDRESS)).toEqual(['Alpha St', 'charlie Rd', 'Delta Ave']);
  });
});

describe('sortPermits — opened-basis counties (PRC)', () => {
  // Citrus-shaped rows carry OPENED_DATE (no issue date). Date sorting must still work: the sort's
  // date keys union in the opened-basis fields, so newest/oldest order by OPENED_DATE.
  const openedRows = () => [
    { PERMITNO: 'O-1', OPENED_DATE: '2026-07-10' },
    { PERMITNO: 'O-2', OPENED_DATE: '2026-07-27' },
    { PERMITNO: 'O-3', OPENED_DATE: '2026-07-01' },
  ];
  it('newest first orders opened-basis rows by OPENED_DATE desc', () => {
    expect(nos(sortPermits(openedRows(), 'newest'))).toEqual(['O-2', 'O-1', 'O-3']);
  });
  it('oldest first orders opened-basis rows by OPENED_DATE asc', () => {
    expect(nos(sortPermits(openedRows(), 'oldest'))).toEqual(['O-3', 'O-1', 'O-2']);
  });
});

describe('sortPermits — safety & determinism', () => {
  it('does not mutate the original input array', () => {
    const input = rows();
    const snapshot = JSON.parse(JSON.stringify(input));
    sortPermits(input, 'value_desc');
    expect(input).toEqual(snapshot);
    expect(nos(input)).toEqual(['BLD-2026-00030', 'BLD-2026-00002', 'BLD-2026-00100']); // original order intact
  });

  it('equal sort values remain stable (prior order preserved)', () => {
    const tied = [
      { PERMITNO: 'A', FINAL_VALUATION: '100' },
      { PERMITNO: 'B', FINAL_VALUATION: '100' },
      { PERMITNO: 'C', FINAL_VALUATION: '100' },
    ];
    expect(sortPermits(tied, 'value_desc').map(r => r.PERMITNO)).toEqual(['A', 'B', 'C']);
    expect(sortPermits(tied, 'value_asc').map(r => r.PERMITNO)).toEqual(['A', 'B', 'C']);
  });

  it('missing/invalid dates sort last, deterministically (both directions)', () => {
    const r = [
      { PERMITNO: 'HAS', LAST_ISSUED_DATE: '2026-07-05' },
      { PERMITNO: 'MISS' },                        // no date
      { PERMITNO: 'BAD', LAST_ISSUED_DATE: 'not-a-date' },
    ];
    expect(nos(sortPermits(r, 'newest'))).toEqual(['HAS', 'MISS', 'BAD']);
    expect(nos(sortPermits(r, 'oldest'))).toEqual(['HAS', 'MISS', 'BAD']);
  });

  it('missing/invalid valuations sort last, deterministically', () => {
    const r = [
      { PERMITNO: 'NUM', FINAL_VALUATION: '500' },
      { PERMITNO: 'MISS' },
      { PERMITNO: 'JUNK', FINAL_VALUATION: 'N/A' },
    ];
    expect(nos(sortPermits(r, 'value_desc'))).toEqual(['NUM', 'MISS', 'JUNK']);
    expect(nos(sortPermits(r, 'value_asc'))).toEqual(['NUM', 'MISS', 'JUNK']);
  });

  it('only reorders supplied rows — never adds/removes records', () => {
    const input = rows();
    const out = sortPermits(input, 'newest');
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).not.toBeNull();
    for (const r of out) expect(input).toContain(r); // every output row came from the input
  });

  it('default ("") returns all supplied rows in original order (a copy)', () => {
    const input = rows();
    const out = sortPermits(input, '');
    expect(out).toEqual(input);
    expect(out).not.toBe(input); // new array (no mutation risk)
  });

  it('unknown option falls back to original order', () => {
    const input = rows();
    expect(sortPermits(input, 'bogus' as any)).toEqual(input);
  });
});

describe('CSV parity — export uses the same sorted array shown on screen', () => {
  it('sorted result feeding the table is the same array CSV serializes', () => {
    // The page computes `displayed = sortPermits(filteredPermits, sortOption)` once and passes
    // it to BOTH the table (.slice(0,50)) and buildPermitCsv — this asserts sort is deterministic
    // so both consumers see identical order.
    const filtered = rows();
    const displayedForTable = sortPermits(filtered, 'value_desc');
    const displayedForCsv = sortPermits(filtered, 'value_desc');
    expect(nos(displayedForCsv)).toEqual(nos(displayedForTable));
  });
});

describe('nextSortForColumn — click-to-sort headers (shared sortOption)', () => {
  it('Date: first click from a non-date sort → newest, then toggles newest/oldest', () => {
    expect(nextSortForColumn('date', '')).toBe('newest');          // from default
    expect(nextSortForColumn('date', 'value_desc')).toBe('newest'); // from a non-date sort
    expect(nextSortForColumn('date', 'newest')).toBe('oldest');     // toggle
    expect(nextSortForColumn('date', 'oldest')).toBe('newest');     // toggle back
  });

  it('Value: first click from a non-value sort → highest, then toggles highest/lowest', () => {
    expect(nextSortForColumn('value', '')).toBe('value_desc');        // highest
    expect(nextSortForColumn('value', 'newest')).toBe('value_desc');  // from a non-value sort
    expect(nextSortForColumn('value', 'value_desc')).toBe('value_asc'); // toggle → lowest
    expect(nextSortForColumn('value', 'value_asc')).toBe('value_desc'); // toggle back → highest
  });

  it('Address: selects ascending and NEVER invents a descending order on repeat clicks', () => {
    expect(nextSortForColumn('address', '')).toBe('address_asc');
    expect(nextSortForColumn('address', 'address_asc')).toBe('address_asc'); // repeat stays asc
    expect(nextSortForColumn('address', 'newest')).toBe('address_asc');
  });

  it('a header click yields a value the existing Sort dropdown also uses (shared SortOption)', () => {
    // Every result is a member of the existing SortOption union the dropdown binds to.
    const dropdownValues = ['', 'newest', 'oldest', 'value_desc', 'value_asc', 'permit_asc', 'address_asc'];
    for (const col of ['date', 'value', 'address'] as const) {
      for (const cur of dropdownValues as any[]) {
        expect(dropdownValues).toContain(nextSortForColumn(col, cur));
      }
    }
  });
});

describe('sortIndicatorForColumn — aria-sort / arrow state', () => {
  it('Date: newest → descending, oldest → ascending, otherwise none', () => {
    expect(sortIndicatorForColumn('date', 'newest')).toBe('descending');
    expect(sortIndicatorForColumn('date', 'oldest')).toBe('ascending');
    expect(sortIndicatorForColumn('date', 'value_desc')).toBe('none');
    expect(sortIndicatorForColumn('date', '')).toBe('none');
  });

  it('Value: highest → descending, lowest → ascending, otherwise none', () => {
    expect(sortIndicatorForColumn('value', 'value_desc')).toBe('descending');
    expect(sortIndicatorForColumn('value', 'value_asc')).toBe('ascending');
    expect(sortIndicatorForColumn('value', 'newest')).toBe('none');
  });

  it('Address: address_asc → ascending (only), otherwise none', () => {
    expect(sortIndicatorForColumn('address', 'address_asc')).toBe('ascending');
    expect(sortIndicatorForColumn('address', 'newest')).toBe('none');
    expect(sortIndicatorForColumn('address', '')).toBe('none');
  });
});
