import { describe, it, expect } from 'vitest';
import {
  effectivePermitDate, dateLabel, normalizeBasis, basisOf, DEFAULT_DATE_LABEL,
} from '../lib/dateBasis';

// The API is the source of truth for WHICH date a county uses and HOW it's labeled. These tests
// pin the two guarantees the dashboard depends on: (1) an issued-basis row renders LAST_ISSUED_DATE
// and an opened-basis row renders OPENED_DATE, and (2) a date is NEVER cross-copied between bases
// (an opened-only row shows nothing under an issued basis, and vice-versa — never a fabricated date).

const issuedRow = { LAST_ISSUED_DATE: '2026-07-27', OPENED_DATE: '2026-01-02' };
const openedRow = { OPENED_DATE: '2026-07-01' };            // Citrus shape: opened date only
const lowerRow  = { opened_date: '2026-06-15' };            // lowercase fallback

describe('normalizeBasis', () => {
  it("supports explicit opened/issued and holds missing or unknown basis", () => {
    expect(normalizeBasis('opened')).toBe('opened');
    expect(normalizeBasis('issued')).toBe('issued');
    expect(normalizeBasis('')).toBe('unknown');
    expect(normalizeBasis(undefined)).toBe('unknown');
    expect(normalizeBasis('nonsense')).toBe('unknown');
  });
});

describe('effectivePermitDate', () => {
  it('issued basis reads the issue date', () => {
    expect(effectivePermitDate(issuedRow, 'issued')).toBe('2026-07-27');
  });
  it('opened basis reads the opened date (UPPER + lowercase fallback)', () => {
    expect(effectivePermitDate(openedRow, 'opened')).toBe('2026-07-01');
    expect(effectivePermitDate(lowerRow, 'opened')).toBe('2026-06-15');
  });
  it('never cross-copies: opened-only row under issued basis is blank (no fabricated issue date)', () => {
    expect(effectivePermitDate(openedRow, 'issued')).toBe('');
  });
  it('never cross-copies: issued basis on a dual row ignores OPENED_DATE', () => {
    // issuedRow carries both; under issued basis it must return the ISSUED date, not the opened one.
    expect(effectivePermitDate(issuedRow, 'issued')).toBe('2026-07-27');
  });
  it('blank when the basis field is absent (never invents a value)', () => {
    expect(effectivePermitDate({}, 'opened')).toBe('');
    expect(effectivePermitDate({}, 'issued')).toBe('');
  });
});

describe('dateLabel', () => {
  it('uses coverage.date_label verbatim when present', () => {
    expect(dateLabel({ date_label: 'Record opened', date_basis: 'opened' })).toBe('Record opened');
    expect(dateLabel({ date_label: 'Permit issued', date_basis: 'issued' })).toBe('Permit issued');
  });
  it('falls back to the basis default when the label is missing/blank', () => {
    expect(dateLabel({ date_basis: 'opened' })).toBe(DEFAULT_DATE_LABEL.opened);
    expect(dateLabel({ date_basis: 'issued' })).toBe(DEFAULT_DATE_LABEL.issued);
    expect(dateLabel({ date_label: '   ', date_basis: 'opened' })).toBe(DEFAULT_DATE_LABEL.opened);
    expect(dateLabel(null)).toBe(DEFAULT_DATE_LABEL.unknown);
  });
});

describe('basisOf', () => {
  it('reads explicit basis and holds absent metadata', () => {
    expect(basisOf({ date_basis: 'opened' })).toBe('opened');
    expect(basisOf({ date_basis: 'issued' })).toBe('issued');
    expect(basisOf(null)).toBe('unknown');
  });
});

describe('unverified date boundaries', () => {
  it('does not read issue-shaped fields when metadata is missing or unsupported', () => {
    for (const basis of [undefined, null, '', 'inspection', 'application', 'updated', 'record']) {
      expect(effectivePermitDate(issuedRow, basis)).toBe('');
      expect(dateLabel({date_basis: basis, date_label: 'Permit issued'})).toBe('Date not verified');
    }
  });
  it('never treats generic permit_date as a verified issue date', () => {
    expect(effectivePermitDate({permit_date: '2026-11-01'}, 'issued')).toBe('');
    expect(effectivePermitDate({permit_date: '2026-11-01', issue_date: '2026-10-30'}, 'issued')).toBe('2026-10-30');
  });
});
