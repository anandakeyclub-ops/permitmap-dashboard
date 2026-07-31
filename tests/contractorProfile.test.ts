import { describe, it, expect } from 'vitest';
import {
  getContractorName, normalizeContractor, parseValuation, formatMoney,
  buildContractorProfile, RECENT_LIMIT,
} from '../lib/contractorProfile';

// Raw permit shape (UPPER_SNAKE), as loaded for the current county.
const P = (over: Record<string, any>): Record<string, any> => ({
  PERMITNO: 'BLD-0001', CONTRACTOR_NAME: 'Ace Roofing', LAST_ISSUED_DATE: '2026-07-01',
  FULL_ADDRESS: '1 Main St', trade: 'roofing', FINAL_VALUATION: '$10,000', STATUS: 'Issued',
  ...over,
});

describe('normalizeContractor / getContractorName', () => {
  it('matches case-insensitively and trims whitespace (no fuzzy matching)', () => {
    expect(normalizeContractor('  Ace Roofing ')).toBe('ace roofing');
    expect(normalizeContractor('ACE ROOFING')).toBe('ace roofing');
    expect(normalizeContractor('Ace  Roofing')).not.toBe('ace roofing'); // internal spacing NOT collapsed
    expect(normalizeContractor('Ace Roofing LLC')).not.toBe('ace roofing'); // suffix NOT normalized
  });

  it('reads the contractor via CONTRACTOR_NAME then lowercase fallbacks', () => {
    expect(getContractorName({ CONTRACTOR_NAME: 'Ace' })).toBe('Ace');
    expect(getContractorName({ contractor_name: 'Bee' })).toBe('Bee');
    expect(getContractorName({ contractor: 'Cee' })).toBe('Cee');
    expect(getContractorName({})).toBe('');
  });
});

describe('parseValuation / formatMoney', () => {
  it('parses $ and commas, keeps only positive numbers', () => {
    expect(parseValuation('$10,000')).toBe(10000);
    expect(parseValuation('99500.5')).toBe(99500.5);
    expect(parseValuation('0')).toBeNull();
    expect(parseValuation('N/A')).toBeNull();
    expect(parseValuation(undefined)).toBeNull();
    expect(parseValuation('')).toBeNull();
  });
  it('formats money like the drawer/table; null → em dash', () => {
    expect(formatMoney(10000)).toBe('$10,000');
    expect(formatMoney(null)).toBe('—');
  });
});

describe('buildContractorProfile — matching & aggregation', () => {
  const permits = [
    P({ PERMITNO: 'A1', CONTRACTOR_NAME: 'Ace Roofing',  LAST_ISSUED_DATE: '2026-07-10', trade: 'roofing',  FINAL_VALUATION: '$10,000' }),
    P({ PERMITNO: 'A2', CONTRACTOR_NAME: 'ace roofing',  LAST_ISSUED_DATE: '2026-07-20', trade: 'roofing',  FINAL_VALUATION: '$30,000' }),
    P({ PERMITNO: 'A3', CONTRACTOR_NAME: '  Ace Roofing ', LAST_ISSUED_DATE: '2026-07-05', trade: 'hvac',   FINAL_VALUATION: 'N/A' }),   // invalid valuation
    P({ PERMITNO: 'B1', CONTRACTOR_NAME: 'Other Co',     LAST_ISSUED_DATE: '2026-07-28', trade: 'plumbing', FINAL_VALUATION: '$99,000' }),
  ];

  it('matches case-insensitively and after trimming; ignores other contractors', () => {
    const d = buildContractorProfile(permits, 'Ace Roofing', 'marion')!;
    expect(d.permitCount).toBe(3); // A1, A2, A3 — not B1
  });

  it('preserves the original display name and echoes county as an explicit input', () => {
    const d = buildContractorProfile(permits, 'Ace Roofing', 'marion')!;
    expect(d.displayName).toBe('Ace Roofing');
    expect(d.county).toBe('marion');
  });

  it('totals only valid valuations and averages over the valid count only', () => {
    const d = buildContractorProfile(permits, 'Ace Roofing', 'marion')!;
    expect(d.validValuationCount).toBe(2);           // A1 + A2 (A3 is N/A)
    expect(d.totalValuation).toBe(40000);            // 10,000 + 30,000
    expect(d.averageValuation).toBe(20000);          // 40,000 / 2  (denominator = valid count)
  });

  it('handles no valid valuations safely (total & average null → em dash via formatMoney)', () => {
    const noVal = [P({ CONTRACTOR_NAME: 'Zed', FINAL_VALUATION: 'N/A' }), P({ CONTRACTOR_NAME: 'Zed', FINAL_VALUATION: '0' })];
    const d = buildContractorProfile(noVal, 'Zed', 'marion')!;
    expect(d.validValuationCount).toBe(0);
    expect(d.totalValuation).toBeNull();
    expect(d.averageValuation).toBeNull();
    expect(formatMoney(d.totalValuation)).toBe('—');
  });

  it('identifies the newest permit date', () => {
    const d = buildContractorProfile(permits, 'Ace Roofing', 'marion')!;
    expect(d.mostRecentDate).toBe('2026-07-20'); // A2
  });

  it('returns unique trades', () => {
    const d = buildContractorProfile(permits, 'Ace Roofing', 'marion')!;
    expect([...d.trades].sort()).toEqual(['hvac', 'roofing']);
  });

  it('sorts recent permits newest first', () => {
    const d = buildContractorProfile(permits, 'Ace Roofing', 'marion')!;
    expect(d.recentPermits.map(r => r.permitNumber)).toEqual(['A2', 'A1', 'A3']);
  });

  it('caps recent permits at 10 (RECENT_LIMIT)', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      P({ PERMITNO: `M${i}`, CONTRACTOR_NAME: 'Big Co', LAST_ISSUED_DATE: `2026-07-${String((i % 27) + 1).padStart(2, '0')}` }));
    const d = buildContractorProfile(many, 'Big Co', 'marion')!;
    expect(RECENT_LIMIT).toBe(10);
    expect(d.recentPermits).toHaveLength(10);
  });

  it('renders missing fields safely as em dash inside recent permits', () => {
    const sparse = [{ CONTRACTOR_NAME: 'Sparse Co' }]; // only a name
    const d = buildContractorProfile(sparse, 'Sparse Co', 'marion')!;
    const r = d.recentPermits[0];
    expect(r).toEqual({ permitNumber: '—', issueDate: '—', address: '—', trade: '—', valuation: '—', status: '—' });
    expect(d.mostRecentDate).toBeNull();
    expect(d.totalValuation).toBeNull();
  });

  it('does not mutate the source permits array or its objects', () => {
    const snapshot = JSON.parse(JSON.stringify(permits));
    buildContractorProfile(permits, 'Ace Roofing', 'marion');
    expect(permits).toEqual(snapshot);
  });
});

describe('buildContractorProfile — safety & integration invariants', () => {
  it('empty / whitespace contractor name produces no profile (null)', () => {
    expect(buildContractorProfile([P({})], '', 'marion')).toBeNull();
    expect(buildContractorProfile([P({})], '   ', 'marion')).toBeNull();
  });

  it('derives exclusively from the supplied array — an empty array yields a zeroed profile', () => {
    const d = buildContractorProfile([], 'Ace Roofing', 'marion')!;
    expect(d.permitCount).toBe(0);
    expect(d.recentPermits).toEqual([]);
    expect(d.trades).toEqual([]);
    expect(d.totalValuation).toBeNull();
    expect(d.mostRecentDate).toBeNull();
  });

  it('only aggregates permits from the requested contractor (no leakage across names)', () => {
    const mixed = [
      P({ CONTRACTOR_NAME: 'Ace Roofing', FINAL_VALUATION: '$5,000' }),
      P({ CONTRACTOR_NAME: 'Zed Co', FINAL_VALUATION: '$999,999' }),
    ];
    const d = buildContractorProfile(mixed, 'Ace Roofing', 'marion')!;
    expect(d.permitCount).toBe(1);
    expect(d.totalValuation).toBe(5000); // Zed's $999,999 never leaks in
  });
});
