import { describe, it, expect } from 'vitest';
import {
  saveLeadPermitId, buildSaveLeadPayload, canSaveLead, savedIdsAfter,
} from '../lib/saveLeadState';

const permit = {
  PERMITNO: 'BLD-2026-00915', county: 'marion', FULL_ADDRESS: '1420 SE 17th St, Ocala',
  trade: 'roofing', FINAL_VALUATION: '$18,500', LAST_ISSUED_DATE: '2026-07-27', score: 91,
  RECORD_TYPE: 'Building', OWNER_NAME: 'ignored', extra: 'ignored',
};

describe('permit identity + payload (exact existing contract)', () => {
  it('derives permit_id from PERMITNO', () => {
    expect(saveLeadPermitId(permit)).toBe('BLD-2026-00915');
    expect(saveLeadPermitId({})).toBe('');
  });

  it('builds the exact /saved-leads payload used by CallList', () => {
    expect(buildSaveLeadPayload(permit)).toEqual({
      permit_id: 'BLD-2026-00915',
      county: 'marion',
      address: '1420 SE 17th St, Ocala',
      trade: 'roofing',
      value: '$18,500',
      permit_date: '2026-07-27',
      score: 91,
    });
  });

  it('uses lowercase fallbacks and null-defaults exactly as before', () => {
    expect(buildSaveLeadPayload({ PERMITNO: 'X', full_address: '5 Oak', final_valuation: 1200, last_issued_date: '2026-07-01' }))
      .toEqual({ permit_id: 'X', county: '', address: '5 Oak', trade: null, value: 1200, permit_date: '2026-07-01', score: null });
    expect(buildSaveLeadPayload({})).toEqual({
      permit_id: '', county: '', address: '', trade: null, value: null, permit_date: null, score: null,
    });
  });

  it('does not mutate the source permit', () => {
    const snap = JSON.parse(JSON.stringify(permit));
    buildSaveLeadPayload(permit);
    saveLeadPermitId(permit);
    expect(permit).toEqual(snap);
  });
});

describe('canSaveLead — dedup + loading guard', () => {
  it('allows saving a real, unsaved, not-in-flight permit', () => {
    expect(canSaveLead('P1', new Set(), null)).toBe(true);
  });
  it('blocks an empty permit id', () => {
    expect(canSaveLead('', new Set(), null)).toBe(false);
  });
  it('blocks an already-saved permit (dedup)', () => {
    expect(canSaveLead('P1', new Set(['P1']), null)).toBe(false);
  });
  it('blocks a permit whose save is in flight (prevents duplicate requests)', () => {
    expect(canSaveLead('P1', new Set(), 'P1')).toBe(false);
  });
  it('allows retry after a failure (not in savedIds, not in flight)', () => {
    // after an error: savingLeadId cleared, permit never added to savedIds
    expect(canSaveLead('P1', new Set(), null)).toBe(true);
  });
});

describe('savedIdsAfter — outcome → membership', () => {
  it('successful save adds the permit_id', () => {
    expect(savedIdsAfter(new Set(), 'P1', 'success').has('P1')).toBe(true);
  });
  it('already_saved response also adds the permit_id', () => {
    expect(savedIdsAfter(new Set(), 'P1', 'already_saved').has('P1')).toBe(true);
  });
  it('failed save does NOT add the permit_id', () => {
    expect(savedIdsAfter(new Set(), 'P1', 'error').has('P1')).toBe(false);
  });
  it('returns a new set and never mutates the input', () => {
    const prev = new Set(['A']);
    const next = savedIdsAfter(prev, 'B', 'success');
    expect(next).not.toBe(prev);
    expect([...prev]).toEqual(['A']);          // input unchanged
    expect([...next].sort()).toEqual(['A', 'B']);
  });
  it('preserves existing saved ids', () => {
    expect([...savedIdsAfter(new Set(['A', 'B']), 'C', 'success')].sort()).toEqual(['A', 'B', 'C']);
  });
});
