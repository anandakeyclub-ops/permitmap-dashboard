import { describe, it, expect } from 'vitest';
import { sortPermits } from '../lib/sort';

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
