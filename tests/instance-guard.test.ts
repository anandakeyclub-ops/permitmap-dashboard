import { describe, it, expect } from 'vitest';
import { assertProductionInstances, clerkKind, stripeKind } from '../scripts/instance-guard';

describe('production tools instance guard', () => {
  it('classifies key prefixes', () => {
    expect(clerkKind('sk_live_x')).toBe('production'); expect(clerkKind('sk_test_x')).toBe('development'); expect(clerkKind('foo')).toBe('unknown');
    expect(stripeKind('rk_live_x')).toBe('live'); expect(stripeKind('sk_test_x')).toBe('test');
  });
  it('accepts live Stripe + production Clerk', () => {
    expect(assertProductionInstances('rk_live_a', 'sk_live_b', [])).toMatchObject({ stripe: 'live', clerk: 'production' });
  });
  it('REFUSES a development Clerk key by default (the mistake that produced non-production evidence)', () => {
    expect(() => assertProductionInstances('rk_live_a', 'sk_test_b', [])).toThrow(/DEVELOPMENT instance/);
  });
  it('--allow-dev-clerk permits it but the banner screams it is not production evidence', () => {
    const r = assertProductionInstances('rk_live_a', 'sk_test_b', ['--allow-dev-clerk']);
    expect(r.clerk).toBe('development'); expect(r.banner).toMatch(/NOT PRODUCTION EVIDENCE/);
  });
  it('refuses test Stripe and unknown Clerk prefixes regardless of flags', () => {
    expect(() => assertProductionInstances('sk_test_a', 'sk_live_b', ['--allow-dev-clerk'])).toThrow(/Stripe key is test/);
    expect(() => assertProductionInstances('rk_live_a', 'pk_live_b', [])).toThrow(/not recognised/);
  });
});
