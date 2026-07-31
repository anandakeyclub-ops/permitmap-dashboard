import { describe, it, expect } from 'vitest';
import { matchesKeywords, filterByKeywords } from '../lib/search';

// Raw API permit shape (UPPER_SNAKE), as returned by /permits for the authorized county.
const P = {
  gen: {
    PERMITNO: 'BLD-2026-00915', RECORD_TYPE: 'Electrical',
    PERMIT_DESCRIPTION: 'Install 22kW standby GENERATOR with automatic transfer switch',
    WORK_DESCRIPTION: 'Whole-home backup power',
    CONTRACTOR_NAME: 'Generator Supercenter of Ocala', OWNER_NAME: 'Jane Doe',
    FULL_ADDRESS: '1420 SE 17th St, Ocala', trade: 'electrical',
  },
  roof: {
    PERMITNO: 'BLD-2026-00420', PERMIT_DESCRIPTION: 'Re-roof, architectural shingle',
    WORK_DESCRIPTION: 'Tear off and replace', CONTRACTOR_NAME: 'Ace Roofing',
    OWNER_NAME: 'John Smith', FULL_ADDRESS: '88 NW 5th Ave, Ocala', trade: 'roofing',
  },
  pool: {
    PERMITNO: 'BLD-2026-00777', PERMIT_DESCRIPTION: 'Pool screen enclosure',
    CONTRACTOR_NAME: 'Sunshine Pools', OWNER_NAME: 'Maria Generosa',
    FULL_ADDRESS: '5 Generator Way', trade: 'pool',
  },
};
const ALL = [P.gen, P.roof, P.pool];

describe('keyword matching', () => {
  it('"generator" matches Generator / GENERATOR / generator (case-insensitive)', () => {
    expect(matchesKeywords(P.gen, 'generator')).toBe(true);   // GENERATOR in description
    expect(matchesKeywords(P.gen, 'GENERATOR')).toBe(true);
    expect(matchesKeywords(P.gen, 'Generator')).toBe(true);
  });
  it('partial term matches (substring)', () => {
    expect(matchesKeywords(P.gen, 'gener')).toBe(true);
    expect(matchesKeywords(P.gen, 'standb')).toBe(true);
  });
  it('searches permit description AND work description', () => {
    expect(matchesKeywords(P.gen, 'standby')).toBe(true);       // PERMIT_DESCRIPTION
    expect(matchesKeywords(P.gen, 'backup power')).toBe(true);  // WORK_DESCRIPTION
  });
  it('searches contractor', () => { expect(matchesKeywords(P.gen, 'supercenter')).toBe(true); });
  it('searches owner', () => { expect(matchesKeywords(P.roof, 'john smith')).toBe(true); });
  it('searches address', () => { expect(matchesKeywords(P.gen, 'ocala')).toBe(true); });
  it('searches permit number', () => { expect(matchesKeywords(P.gen, 'bld-2026-00915')).toBe(true); });

  it('multiple words use AND semantics across combined fields', () => {
    // "standby" (description) + "supercenter" (contractor) both present → match
    expect(matchesKeywords(P.gen, 'standby supercenter')).toBe(true);
    // "standby generator" both present
    expect(matchesKeywords(P.gen, 'standby generator')).toBe(true);
    // one term absent → no match
    expect(matchesKeywords(P.gen, 'standby roofing')).toBe(false);
  });

  it('whitespace-only / blank query returns all records', () => {
    for (const p of ALL) {
      expect(matchesKeywords(p, '')).toBe(true);
      expect(matchesKeywords(p, '   ')).toBe(true);
    }
    expect(filterByKeywords(ALL, '   ')).toEqual(ALL);
  });
});

describe('filterByKeywords (reused by CSV export)', () => {
  it('trims the query and matches partials', () => {
    expect(filterByKeywords(ALL, '  generator  ').map(p => p.PERMITNO))
      .toEqual(['BLD-2026-00915', 'BLD-2026-00777']); // gen (desc/contractor) + pool (address "Generator Way")
  });

  it('remains constrained to the input set (county/trade/date/entitlement-filtered upstream)', () => {
    // Simulate the trade-filtered input the dashboard passes in (electrical only).
    const electricalOnly = ALL.filter(p => p.trade === 'electrical');
    const out = filterByKeywords(electricalOnly, 'generator');
    expect(out).toEqual([P.gen]);       // never reaches roof/pool outside the input set
    expect(out.length).toBe(1);
  });

  it('cannot introduce records absent from the authorized input', () => {
    const authorized = [P.gen];         // only this record was returned for the entitled county
    // A query that would match other counties' records still only sees the authorized input.
    expect(filterByKeywords(authorized, 'roofing')).toEqual([]);
    expect(filterByKeywords(authorized, '').length).toBeLessThanOrEqual(authorized.length);
  });

  it('clear-search (blank) restores the exact input filtered set', () => {
    const input = ALL.filter(p => p.trade !== 'pool');
    expect(filterByKeywords(input, 'generator').length).toBe(1);
    expect(filterByKeywords(input, '')).toEqual(input);     // clear → original set
  });
});

describe('permit type (RECORD_TYPE) is searchable — the audited gap', () => {
  // Mirrors the real Marion served shape: the term lives in RECORD_TYPE; PERMIT_DESCRIPTION is
  // terse/empty. Before this change these permits were unreachable by a "generator" search.
  const marionGen = {
    PERMITNO: 'BLDR-26-07-19632', RECORD_TYPE: 'Residential Generator',
    PERMIT_DESCRIPTION: '', CONTRACTOR_NAME: '', OWNER_NAME: '',
    FULL_ADDRESS: '13131 SW 52ND LANE RD OCALA', trade: 'electrical',
  };
  const roofType = {
    PERMITNO: 'BLDR-26-07-19180', RECORD_TYPE: 'Residential Roof',
    PERMIT_DESCRIPTION: '', FULL_ADDRESS: '5325 SW 129TH TERRACE RD OCALA', trade: 'roofing',
  };

  it('searching "Residential Generator" (full permit type) matches', () => {
    expect(matchesKeywords(marionGen, 'Residential Generator')).toBe(true);
  });
  it('searching "Generator" matches a permit typed only in RECORD_TYPE', () => {
    expect(matchesKeywords(marionGen, 'generator')).toBe(true);   // was previously MISSED
  });
  it('searching another permit type matches (e.g. "residential roof")', () => {
    expect(matchesKeywords(roofType, 'residential roof')).toBe(true);
    expect(matchesKeywords(roofType, 'generator')).toBe(false);   // no cross-type false positive
  });
  it('accepts lowercase fallbacks record_type / permit_type', () => {
    expect(matchesKeywords({ record_type: 'Residential Generator' }, 'generator')).toBe(true);
    expect(matchesKeywords({ permit_type: 'Standby Generator' }, 'standby')).toBe(true);
  });
  it('filters a Marion-like set by permit type without touching other fields', () => {
    const set = [marionGen, roofType];
    expect(filterByKeywords(set, 'generator').map(p => p.PERMITNO)).toEqual(['BLDR-26-07-19632']);
    expect(filterByKeywords(set, 'residential').map(p => p.PERMITNO))
      .toEqual(['BLDR-26-07-19632', 'BLDR-26-07-19180']); // both are "Residential …"
  });
  it('regression: description / contractor / address / owner searches still work unchanged', () => {
    expect(matchesKeywords(P.gen, 'standby')).toBe(true);      // PERMIT_DESCRIPTION
    expect(matchesKeywords(P.gen, 'supercenter')).toBe(true);  // CONTRACTOR_NAME
    expect(matchesKeywords(P.gen, 'ocala')).toBe(true);        // FULL_ADDRESS
    expect(matchesKeywords(P.roof, 'john smith')).toBe(true);  // OWNER_NAME
    expect(matchesKeywords(P.gen, 'bld-2026-00915')).toBe(true); // PERMITNO
  });
});
