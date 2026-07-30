import { describe, it, expect } from 'vitest';
import {
  isCountyLocked, entitledCountyKeys, defaultEntitledCounty, upgradeMessageForCounty, normalizeCounty,
} from '../lib/entitlement';

// Marion sits at index 5 — under the OLD `countyIndex >= limits.counties` (Pro=5) gate it was
// wrongly locked, and indices 0-4 were wrongly unlocked. These tests pin the entitlement-based fix.
const COUNTIES = [
  { key: 'alachua', label: 'Alachua' }, { key: 'duval', label: 'Duval' }, { key: 'lee', label: 'Lee' },
  { key: 'orange', label: 'Orange' }, { key: 'polk', label: 'Polk' }, { key: 'marion', label: 'Marion' },
];

describe('Marion-only Pro trial', () => {
  const tier = 'pro', allowed = ['marion'];

  it('Marion appears (unlocked) despite being at list index >= tier county-count', () => {
    expect(isCountyLocked('marion', tier, allowed)).toBe(false);
  });

  it('Marion-only user cannot see non-entitled counties (all others locked)', () => {
    for (const c of COUNTIES.filter(c => c.key !== 'marion')) {
      expect(isCountyLocked(c.key, tier, allowed)).toBe(true);
    }
  });

  it('entitledCountyKeys returns only Marion', () => {
    expect(entitledCountyKeys(COUNTIES, tier, allowed)).toEqual(['marion']);
  });

  it('selection defaults to the entitled county (Marion), not list position 0', () => {
    expect(defaultEntitledCounty(COUNTIES, tier, allowed)).toBe('marion');
  });

  it('upgrade is shown only for non-entitled counties (locked === upgrade path)', () => {
    expect(isCountyLocked('marion', tier, allowed)).toBe(false); // no upgrade
    expect(isCountyLocked('duval', tier, allowed)).toBe(true);   // upgrade
  });
});

describe('tier behavior', () => {
  it('Team unlocks every county', () => {
    for (const c of COUNTIES) expect(isCountyLocked(c.key, 'team', [])).toBe(false);
    expect(defaultEntitledCounty(COUNTIES, 'team', [])).toBe('alachua');
  });

  it('Preview / unprovisioned (empty allowed_counties) locks all', () => {
    for (const c of COUNTIES) expect(isCountyLocked(c.key, 'preview', [])).toBe(true);
    expect(isCountyLocked('marion', 'pro', [])).toBe(true);
    expect(defaultEntitledCounty(COUNTIES, 'pro', [])).toBe('');
  });

  it('normalizes county key/label variants', () => {
    expect(normalizeCounty('St. Lucie')).toBe('st_lucie');
    expect(isCountyLocked('Marion', 'pro', ['marion'])).toBe(false);
    expect(isCountyLocked('marion', 'pro', ['Marion'])).toBe(false);
    expect(isCountyLocked('palm-beach', 'pro', ['palm_beach'])).toBe(false);
  });
});

describe('D — upgrade messaging', () => {
  it('explains the trial county instead of a bare "Upgrade"', () => {
    expect(upgradeMessageForCounty('Duval', ['Marion']))
      .toBe('This trial currently includes Marion County. Upgrade to add Duval County.');
  });
  it('multi-county plan lists included counties', () => {
    expect(upgradeMessageForCounty('Duval', ['Marion', 'Lee']))
      .toContain('Your plan currently includes Marion, Lee');
  });
  it('no entitlement → start-trial message', () => {
    expect(upgradeMessageForCounty('Duval', [])).toContain('Start your trial to unlock Duval');
  });
});
