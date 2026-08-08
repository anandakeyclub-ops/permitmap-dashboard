// P4 Onboarding Completion Contract tests — pure logic + webhook onboarding-stamp integration.
import { describe, it, expect, vi } from 'vitest';
import {
  validateSelectedCounties, validateSelectedTrades, evaluateOnboarding, classifyOnboarding,
  recomputeOnboardingOnTierChange, entitlementCountyLimit, migrateLegacySelectedCounties,
  SUPPORTED_TRADES, ONBOARDING_STATES, REASONS,
} from '../lib/onboarding';
import { handleWebhook } from '../lib/provisioning';

const FL = ['palm_beach', 'marion', 'bexar', 'broward', 'lee', 'hillsborough']; // supported slugs

// ── the incident: Pro with allowance 5 but NO real selection is NOT complete ────
it('Belman state — Pro, allowance 5, zero counties, zero trades → INCOMPLETE', () => {
  const r = evaluateOnboarding({ tier: 'pro', selected_counties: [], selected_trades: [], email: 'a@x.com' }, FL);
  expect(r.state).toBe(ONBOARDING_STATES.INCOMPLETE);
  expect(r.complete).toBe(false);
  expect(r.reasons).toContain(REASONS.MISSING_COUNTY);
  expect(r.reasons).toContain(REASONS.MISSING_TRADE);
  expect(classifyOnboarding({ tier: 'pro', selected_counties: [], selected_trades: [], email: 'a@x.com' }, FL))
    .toBe('onboarding_incomplete');
});

it('Pro with one valid county + one trade → COMPLETE', () => {
  const r = evaluateOnboarding({ tier: 'pro', selected_counties: ['palm_beach'], selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(r).toEqual({ state: ONBOARDING_STATES.COMPLETE, complete: true, reasons: [], needs_review: false });
});

// ── county limit enforced (server-side) ────────────────────────────────────────
it('exceeding the tier county limit is rejected + flagged needs_review', () => {
  const six = ['palm_beach', 'marion', 'bexar', 'broward', 'lee', 'hillsborough'];
  const v = validateSelectedCounties(six, 'pro', FL);
  expect(v.ok).toBe(false);
  expect(v.errors.some((e) => e.startsWith('exceeds_county_limit'))).toBe(true);
  const r = evaluateOnboarding({ tier: 'pro', selected_counties: six, selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(r.state).toBe(ONBOARDING_STATES.NEEDS_REVIEW);
  expect(r.reasons).toContain(REASONS.OVER_LIMIT);
  expect(entitlementCountyLimit('pro')).toBe(5);
});

it('unsupported county is rejected', () => {
  const v = validateSelectedCounties(['palm_beach', 'atlantis'], 'pro', FL);
  expect(v.cleaned).toEqual(['palm_beach']);
  expect(v.errors).toContain('unsupported_county:atlantis');
  expect(evaluateOnboarding({ tier: 'pro', selected_counties: ['atlantis'], selected_trades: ['roofing'], email: 'a@x.com' }, FL).reasons)
    .toContain(REASONS.INVALID_COUNTY);
});

it('duplicates + mixed formatting are normalized deterministically', () => {
  const v = validateSelectedCounties(['Palm Beach', 'palm_beach', 'palm-beach', 'PALM.BEACH'], 'pro', FL);
  expect(v.cleaned).toEqual(['palm_beach']);
  expect(v.ok).toBe(true);
});

// ── trades: canonical 7-slug set (generator/foundation NOT selectable) ──────────
it('trades: required, canonicalized, aliases mapped, unsupported rejected', () => {
  expect([...SUPPORTED_TRADES]).toEqual(['roofing', 'hvac', 'plumbing', 'electrical', 'pool', 'solar', 'general_contractor']);
  for (const t of SUPPORTED_TRADES) expect(validateSelectedTrades([t]).ok).toBe(true);
  expect(validateSelectedTrades([]).errors).toContain('no_trade_selected');
  expect(validateSelectedTrades(['GC', 'general_contractors', 'roofing']).cleaned).toEqual(['general_contractor', 'roofing']);
  expect(validateSelectedTrades(['unicorn']).errors).toContain('unsupported_trade:unicorn');
  // generator/foundation are county source-coverage concerns, not selectable trades
  expect(validateSelectedTrades(['generator']).errors).toContain('unsupported_trade:generator');
  expect(validateSelectedTrades(['foundation']).errors).toContain('unsupported_trade:foundation');
});

// ── team tier: all counties, but a trade is still required ──────────────────────
it('team needs no county selection but still needs a trade', () => {
  expect(evaluateOnboarding({ tier: 'team', selected_counties: [], selected_trades: ['roofing'], email: 'a@x.com' }).complete).toBe(true);
  expect(evaluateOnboarding({ tier: 'team', selected_counties: [], selected_trades: [], email: 'a@x.com' }).reasons).toContain(REASONS.MISSING_TRADE);
});

// ── delivery email ──────────────────────────────────────────────────────────────
it('missing delivery email blocks completion', () => {
  expect(evaluateOnboarding({ tier: 'pro', selected_counties: ['palm_beach'], selected_trades: ['roofing'], email: null }, FL).reasons)
    .toContain(REASONS.MISSING_EMAIL);
});

// ── legacy migration (defect 1): never turn a numeric allowance into a selection ─
it('migrateLegacySelectedCounties: "5" does NOT become a selection; slug list migrates; canonical wins', () => {
  expect(migrateLegacySelectedCounties({ allowed_counties: '5' })).toEqual([]);
  expect(migrateLegacySelectedCounties({ allowed_counties: 5 as any })).toEqual([]);
  expect(migrateLegacySelectedCounties({})).toEqual([]);
  expect(migrateLegacySelectedCounties(null)).toEqual([]);
  expect(migrateLegacySelectedCounties({ allowed_counties: ['palm_beach', 'marion'] })).toEqual(['palm_beach', 'marion']);
  expect(migrateLegacySelectedCounties({ selected_counties: ['lee'], allowed_counties: ['marion'] })).toEqual(['lee']);
});

it('a Belman legacy row (numeric allowance, no selection) stays incomplete', () => {
  const sel = migrateLegacySelectedCounties({ tier: 'pro', counties_allowed: 5, allowed_counties: null });
  expect(sel).toEqual([]);
  expect(evaluateOnboarding({ tier: 'pro', selected_counties: sel, selected_trades: [], email: 'a@x.com' }, FL).complete).toBe(false);
});

// ── recovery on plan change (Phase 9) ──────────────────────────────────────────
it('upgrade preserves selections and can complete; downgrade over-limit needs review (never deleted)', () => {
  const up = recomputeOnboardingOnTierChange({ tier: 'pro', selected_counties: ['palm_beach'], selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(up).toEqual({ onboarding_complete: true, onboarding_state: ONBOARDING_STATES.COMPLETE, needs_review: false });
  const down = recomputeOnboardingOnTierChange({ tier: 'starter', selected_counties: ['palm_beach', 'marion', 'lee'], selected_trades: ['roofing'], email: 'a@x.com' }, FL);
  expect(down).toEqual({ onboarding_complete: false, onboarding_state: ONBOARDING_STATES.NEEDS_REVIEW, needs_review: true });
  expect(classifyOnboarding({ tier: 'starter', selected_counties: ['palm_beach', 'marion', 'lee'], selected_trades: ['roofing'], email: 'a@x.com' }, FL))
    .toBe('invalid_configuration');
});

// ── webhook stamps onboarding_complete + state (Belman flagged at provision time) ──
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

it('webhook stamps onboarding_complete=false + state=incomplete for a new paid sub with no county (Belman prevented)', async () => {
  const s = fakeStripe({ clerk_user_id: 'user_1' });  // no county in metadata
  const clerk = fakeClerk({});                          // no prior selections
  const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', metadata: { clerk_user_id: 'user_1' }, id: 'cs_1' });
  const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert: vi.fn() });
  expect(r.status).toBe(200);
  expect(clerk.updateUserMetadata).toHaveBeenCalledWith('user_1', { publicMetadata: expect.objectContaining({ tier: 'pro', onboarding_complete: false, onboarding_state: ONBOARDING_STATES.INCOMPLETE }) });
});

it('webhook writes selected_counties (not allowed_counties) + completes when county+trades present', async () => {
  const s = fakeStripe({ clerk_user_id: 'user_1', county: 'palm_beach' });
  const clerk = fakeClerk({ selected_trades: ['roofing'] });  // trades already chosen
  const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', metadata: { clerk_user_id: 'user_1', county: 'palm_beach' }, id: 'cs_1' });
  const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert: vi.fn() });
  expect(r.status).toBe(200);
  const payload = (clerk.updateUserMetadata as any).mock.calls[0][1].publicMetadata;
  expect(payload.selected_counties).toEqual(['palm_beach']);
  expect(payload.allowed_counties).toBeUndefined();   // legacy field is NOT written anymore
  expect(payload.onboarding_complete).toBe(true);
});

it('webhook migrates a legacy allowed_counties LIST for completion but never writes it back', async () => {
  const s = fakeStripe({ clerk_user_id: 'user_1' });   // no county on this event
  const clerk = fakeClerk({ allowed_counties: ['palm_beach'], selected_trades: ['roofing'] }); // legacy list
  const body = evt('customer.subscription.updated', { id: 'sub_1', customer: 'cus_1', metadata: { clerk_user_id: 'user_1' }, items: { data: [{ price: { id: 'price_1TMtStIgaDPbFgUVPFOUjBMW' } }] } });
  const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert: vi.fn() });
  expect(r.status).toBe(200);
  const payload = (clerk.updateUserMetadata as any).mock.calls[0][1].publicMetadata;
  expect(payload.onboarding_complete).toBe(true);      // legacy list satisfied the county requirement
  expect(payload.selected_counties).toBeUndefined();   // not fabricated onto the write
});
