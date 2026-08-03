import { describe, it, expect } from 'vitest';
import {
  isIsoDate, shiftDays, clampDate, getPresetRange, isValidCustomRange, effectiveRange, formatHuman,
} from '../lib/dateRange';
import { buildPermitsPath } from '../lib/liveSearch';

// Marion production bounds (anchor = availableTo, NOT today).
const FROM = '2026-04-09';
const TO = '2026-07-31';

describe('isIsoDate (strict)', () => {
  it('accepts valid ISO', () => expect(isIsoDate('2026-07-31')).toBe(true));
  it('rejects non-ISO / impossible / blank', () => {
    expect(isIsoDate('07/31/2026')).toBe(false);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});

describe('getPresetRange — inclusive, anchored to availableTo', () => {
  it('last 7 days', () => expect(getPresetRange('7d', FROM, TO)).toEqual({ from: '2026-07-25', to: TO }));
  it('last 30 days', () => expect(getPresetRange('30d', FROM, TO)).toEqual({ from: '2026-07-02', to: TO }));
  it('last 90 days', () => expect(getPresetRange('90d', FROM, TO)).toEqual({ from: '2026-05-03', to: TO }));
  it('clamps from to availableFrom', () =>
    expect(getPresetRange('90d', '2026-07-20', TO)).toEqual({ from: '2026-07-20', to: TO }));
  it('all/custom → no bounds', () => {
    expect(getPresetRange('all', FROM, TO)).toEqual({ from: null, to: null });
    expect(getPresetRange('custom', FROM, TO)).toEqual({ from: null, to: null });
  });
  it('no availableTo (unknown coverage) → no bounds', () =>
    expect(getPresetRange('30d', null, null)).toEqual({ from: null, to: null }));
});

describe('isValidCustomRange', () => {
  it('valid', () => expect(isValidCustomRange('2026-05-01', '2026-06-01')).toBe(true));
  it('equal ok (inclusive)', () => expect(isValidCustomRange('2026-05-01', '2026-05-01')).toBe(true));
  it('reversed invalid', () => expect(isValidCustomRange('2026-06-01', '2026-05-01')).toBe(false));
  it('partial/blank invalid', () => {
    expect(isValidCustomRange('2026-05-01', null)).toBe(false);
    expect(isValidCustomRange(null, null)).toBe(false);
    expect(isValidCustomRange('bad', '2026-05-01')).toBe(false);
  });
});

describe('effectiveRange', () => {
  const cov = { from: FROM, to: TO };
  it('all → omit', () => expect(effectiveRange('all', null, null, cov)).toEqual({ from: null, to: null }));
  it('preset → computed', () => expect(effectiveRange('30d', null, null, cov)).toEqual({ from: '2026-07-02', to: TO }));
  it('valid custom → clamped to coverage', () =>
    expect(effectiveRange('custom', '2026-01-01', '2026-12-31', cov)).toEqual({ from: FROM, to: TO }));
  it('invalid custom → no request (null bounds)', () =>
    expect(effectiveRange('custom', '2026-06-01', '2026-05-01', cov)).toEqual({ from: null, to: null }));
  it('no coverage → preset yields all', () =>
    expect(effectiveRange('7d', null, null, null)).toEqual({ from: null, to: null }));
});

describe('shiftDays / clampDate — pure, UTC-safe', () => {
  it('shiftDays does not mutate & is UTC', () => {
    const s = '2026-03-01';
    expect(shiftDays(s, -1)).toBe('2026-02-28');
    expect(s).toBe('2026-03-01');
  });
  it('clampDate', () => {
    expect(clampDate('2026-01-01', FROM, TO)).toBe(FROM);
    expect(clampDate('2026-12-01', FROM, TO)).toBe(TO);
    expect(clampDate('2026-05-01', FROM, TO)).toBe('2026-05-01');
  });
});

describe('formatHuman', () => {
  it('formats', () => expect(formatHuman('2026-04-09')).toBe('Apr 9, 2026'));
  it('blank on invalid', () => expect(formatHuman('bad')).toBe(''));
});

describe('buildPermitsPath — date params additive & backward compatible', () => {
  it('no dates → unchanged', () =>
    expect(buildPermitsPath('marion', 500)).toBe('/permits?county=marion&limit=500'));
  it('date_from only', () =>
    expect(buildPermitsPath('marion', 500, null, '2026-04-09', null))
      .toBe('/permits?county=marion&limit=500&date_from=2026-04-09'));
  it('date_to only', () =>
    expect(buildPermitsPath('marion', 500, null, null, '2026-07-31'))
      .toBe('/permits?county=marion&limit=500&date_to=2026-07-31'));
  it('both + query, encoded', () =>
    expect(buildPermitsPath('marion', 500, 'generator', '2026-04-09', '2026-07-31'))
      .toBe('/permits?county=marion&limit=500&query=generator&date_from=2026-04-09&date_to=2026-07-31'));
});
