import { describe, it, expect } from 'vitest';
import {
  TRADE_ORDER, TRADE_COLORS, HIGH_DEMAND, tradeColor, tradeLabel, tradeOptions,
} from '../lib/trades';

// One canonical trade taxonomy. The key guarantee: a NEW trade the API returns that the dashboard
// has never heard of still renders — it gets a neutral color and appears in the filter list — so
// future trades need ZERO dashboard code. Generator + foundation are first-class members here.

describe('canonical taxonomy', () => {
  it('includes generator + foundation as first-class trades, with colors', () => {
    expect(TRADE_ORDER).toContain('generator');
    expect(TRADE_ORDER).toContain('foundation');
    expect(TRADE_COLORS.generator).toBeTruthy();
    expect(TRADE_COLORS.foundation).toBeTruthy();
  });
  it('treats generator as high-demand (matches the API scorer weighting)', () => {
    expect(HIGH_DEMAND.has('generator')).toBe(true);
  });
});

describe('tradeColor', () => {
  it('returns the mapped color for known trades', () => {
    expect(tradeColor('roofing')).toBe(TRADE_COLORS.roofing);
    expect(tradeColor('generator')).toBe(TRADE_COLORS.generator);
  });
  it('returns a neutral default (never undefined) for unknown/blank trades', () => {
    const unknown = tradeColor('geothermal');    // a trade the dashboard has never seen
    expect(unknown).toBeTruthy();
    expect(unknown).toBe(tradeColor(''));         // same neutral default
    expect(tradeColor(null)).toBeTruthy();
    expect(tradeColor(undefined)).toBeTruthy();
  });
});

describe('tradeLabel', () => {
  it('turns underscores into spaces', () => {
    expect(tradeLabel('general_contractor')).toBe('general contractor');
    expect(tradeLabel('roofing')).toBe('roofing');
    expect(tradeLabel(null)).toBe('');
  });
});

describe('tradeOptions', () => {
  it("starts with '' (All) then the canonical order", () => {
    const opts = tradeOptions();
    expect(opts[0]).toBe('');
    expect(opts.slice(1)).toEqual(TRADE_ORDER);
  });
  it('unions in NEW trades present in the data (zero-code for future trades), de-duplicated', () => {
    const opts = tradeOptions(['roofing', 'geothermal', 'geothermal', 'generator', null, '']);
    expect(opts).toContain('geothermal');          // new trade surfaced automatically
    expect(opts.filter(t => t === 'geothermal')).toHaveLength(1); // de-duped
    expect(opts.filter(t => t === 'roofing')).toHaveLength(1);    // canonical, not doubled
    expect(opts[0]).toBe('');
    // extras come AFTER the canonical order
    expect(opts.indexOf('geothermal')).toBeGreaterThan(opts.indexOf('general_contractor'));
  });
});
