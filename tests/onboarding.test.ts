// P4 Onboarding Completion Contract tests — pure logic + webhook onboarding-stamp integration.
import { describe, it, expect, vi } from 'vitest';
import {
  validateSelectedCounties, validateSelectedTrades, evaluateOnboarding, classifyOnboarding,
  recomputeOnboardingOnTierChange, entitlementCountyLimit, SUPPORTED_TRADES,
} from '../lib/onboarding';
import { handleWebhook } from '../lib/provisioning';

const FL = ['palm_beach', 'marion', 'bexar', 'broward', 'lee', 'hillsborough']; // supported slugs

// ── the incident: Pro with allowance 5 but NO real selection is NOT complete ────
it('Belman state — Pro, allowance 5, zero counties, zero trades → INCOMPLETE', () => {
  const r = evaluateOnboarding({ tier: 'pro', allowed_counties: [], selected_trades: [], email: 'a@x.com' }, FL);
  expect(r.complete).toBe(false);
  expect(r.reasons).toContain('no_county_selected');
  expect(r.reasons).toContain('no_trade_selected');
  expect(classifyOnboarding({ tier: 'pro', allowed_counties: [], selected_trades: [], email: 'a@x.com' }, FL))
    .toBe('onboarding_incomplete');
});

it('Pro with one valid county + one trade → COMPLETE', () => {
  const r = evaluateOnboarding({ tier: 'pro', allowed_counties: ['palm_beach'], selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(r).toEqual({ complete: true, reasons: [], needs_review: false });
  expect(classifyOnboarding({ tier: 'pro', allowed_counties: ['palm_beach'], selected_trades: ['roofing'], email: 'a@x.com' }, FL))
    .toBe('onboarding_complete');
});

// ── county limit enforced (server-side) ────────────────────────────────────────
it('exceeding the tier county limit is rejected + flagged over-limit', () => {
  const six = ['palm_beach', 'marion', 'bexar', 'broward', 'lee', 'hillsborough'];
  const v = validateSelectedCounties(six, 'pro', FL);
  expect(v.ok).toBe(false);
  expect(v.errors.some((e) => e.startsWith('exceeds_county_limit'))).toBe(true);
  const r = evaluateOnboarding({ tier: 'pro', allowed_counties: six, selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(r.complete).toBe(false);
  expect(r.reasons).toContain('over_county_limit');
  expect(r.needs_review).toBe(true);
  expect(entitlementCountyLimit('pro')).toBe(5);
});

it('unsupported county is rejected', () => {
  const v = validateSelectedCounties(['palm_beach', 'atlantis'], 'pro', FL);
  expect(v.cleaned).toEqual(['palm_beach']);
  expect(v.errors).toContain('unsupported_county:atlantis');
  expect(evaluateOnboarding({ tier: 'pro', allowed_counties: ['atlantis'], selected_trades: ['roofing'], email: 'a@x.com' }, FL).reasons)
    .toContain('invalid_county');
});

it('duplicates + mixed formatting are normalized deterministically', () => {
  const v = validateSelectedCounties(['Palm Beach', 'palm_beach', 'palm-beach', 'PALM.BEACH'], 'pro', FL);
  expect(v.cleaned).toEqual(['palm_beach']);
  expect(v.ok).toBe(true);
});

// ── trades ───────────────────────────────────────────────────────────────────
it('trades: required, canonicalized, aliases mapped, unsupported rejected', () => {
  expect(validateSelectedTrades([]).errors).toContain('no_trade_selected');
  expect(validateSelectedTrades(['GC', 'general_contractors', 'roofing']).cleaned).toEqual(['general_contractor', 'roofing']);
  expect(validateSelectedTrades(['unicorn']).errors).toContain('unsupported_trade:unicorn');
  expect(SUPPORTED_TRADES).toContain('roofing');   // canonical taxonomy present
});

// ── team tier: all counties, but a trade is still required ──────────────────────
it('team needs no county selection but still needs a trade', () => {
  expect(evaluateOnboarding({ tier: 'team', allowed_counties: [], selected_trades: ['roofing'], email: 'a@x.com' }).complete).toBe(true);
  expect(evaluateOnboarding({ tier: 'team', allowed_counties: [], selected_trades: [], email: 'a@x.com' }).reasons).toContain('no_trade_selected');
});

// ── delivery email ──────────────────────────────────────────────────────────────
it('missing delivery email blocks completion', () => {
  expect(evaluateOnboarding({ tier: 'pro', allowed_counties: ['palm_beach'], selected_trades: ['roofing'], email: null }, FL).reasons)
    .toContain('no_delivery_email');
});

// ── recovery on plan change (Phase 9) ──────────────────────────────────────────
it('upgrade preserves selections and can complete; downgrade over-limit needs review (never deleted)', () => {
  // upgrade starter→pro: existing single county now well within limit
  const up = recomputeOnboardingOnTierChange({ tier: 'pro', allowed_counties: ['palm_beach'], selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(up).toEqual({ onboarding_complete: true, needs_review: false });
  // downgrade team→starter with 3 counties (starter allows 1): kept, but flagged for review, not complete
  const down = recomputeOnboardingOnTierChange({ tier: 'starter', allowed_counties: ['palm_beach', 'marion', 'lee'], selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(down).toEqual({ onboarding_complete: false, needs_review: true });
  expect(classifyOnboarding({ tier: 'starter', allowed_counties: ['palm_beach', 'marion', 'lee'], selected_trades: ['roofing'], email: 'a@x.com' }, FL))
    .toBe('invalid_configuration');
});

// ── webhook stamps onboarding_complete (Belman flagged at provision time) ───────
function evt(type: string, object: any) { return JSON.stringify({ id: 'evt_1', type, data: { object } }); }
const emit = async () => {};

function fakeStripe(subMeta: any, price = 'price_1TMtStIgaDPbFgUVPFOUjBMW') {
  return {
    subscriptions: { retrieve: vi.fn(async () => ({ items: { data: [{ price: { id: price } }] }, metadata: subMeta, status: 'active', customer: 'cus_1' })), update: vi.fn(async () => ({})) },
    customers: { retrieve: vi.fn(async () => ({ email: 'a@x.com' })), update: vi.fn(async () => ({})) },
    webhooks: { constructEvent: vi.fn((b: string) => JSON.parse(b)) },
  };
}
function fakeClerk(publicMetadata: Record<string, any>) {
  const updateUserMetadata = vi.fn(async () => ({}));
  const getUser = vi.fn(async () => ({ publicMetadata }));
  return { updateUserMetadata, getUser,
    users: { updateUserMetadata, getUser, getUserList: vi.fn(async () => ({ totalCount: 0, data: [] })), createUser: vi.fn(async () => ({ id: 'u' })) } };
}

it('webhook stamps onboarding_complete=false for a new paid sub with no county (Belman prevented)', async () => {
  const s = fakeStripe({ clerk_user_id: 'user_1' });  // no county in metadata
  const clerk = fakeClerk({});                          // no prior selections
  const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', metadata: { clerk_user_id: 'user_1' }, id: 'cs_1' });
  const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert: vi.fn() });
  expect(r.status).toBe(200);
  expect(clerk.updateUserMetadata).toHaveBeenCalledWith('user_1', { publicMetadata: expect.objectContaining({ tier: 'pro', onboarding_complete: false }) });
});

it('webhook stamps onboarding_complete=true when county (checkout) + trades (existing) are present', async () => {
  const s = fakeStripe({ clerk_user_id: 'user_1', county: 'palm_beach' });
  const clerk = fakeClerk({ selected_trades: ['roofing'] });  // trades already chosen
  const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', metadata: { clerk_user_id: 'user_1', county: 'palm_beach' }, id: 'cs_1' });
  const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert: vi.fn() });
  expect(r.status).toBe(200);
  expect(clerk.updateUserMetadata).toHaveBeenCalledWith('user_1', { publicMetadata: expect.objectContaining({ onboarding_complete: true, allowed_counties: ['palm_beach'] }) });
});
