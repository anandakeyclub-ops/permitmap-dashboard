import { describe, it, expect, vi } from 'vitest';
import { handleCheckout, buildCheckoutParams, PRICE_BY_PLAN } from '../lib/checkout-session';
import { handleWebhook, resolveClerkUserId, PRICE_TO_TIER } from '../lib/provisioning';
import { startCheckout } from '../lib/start-checkout';

const APP = 'https://app.permitmap.org';

function fakeStripeCheckout() {
  const create = vi.fn(async (params: any) => ({ url: 'https://checkout.stripe.test/x', _params: params }));
  return { create, stripe: { checkout: { sessions: { create } } } };
}

function fakeClerk() {
  const updateUserMetadata = vi.fn(async () => ({}));
  const createUser = vi.fn(async () => ({ id: 'user_created' }));
  const getUserList = vi.fn(async () => ({ totalCount: 0, data: [] as any[] }));
  return { updateUserMetadata, createUser, getUserList, users: { updateUserMetadata, createUser, getUserList } };
}

function fakeStripe(subMeta: any = {}, price = PRICE_TEAM) {
  const customersUpdate = vi.fn(async () => ({}));
  const subsUpdate = vi.fn(async () => ({}));
  return {
    _customersUpdate: customersUpdate, _subsUpdate: subsUpdate,
    subscriptions: {
      retrieve: vi.fn(async (_id: string) => ({ items: { data: [{ price: { id: price } }] }, metadata: subMeta, status: 'trialing', customer: 'cus_1' })),
      update: subsUpdate,
    },
    customers: {
      retrieve: vi.fn(async (_id: string) => ({ email: 'legacy@x.com' })),
      update: customersUpdate,
    },
    webhooks: { constructEvent: vi.fn((b: string) => JSON.parse(b)) },
  };
}

const PRICE_TEAM = 'price_1TMtThIgaDPbFgUVoxIWlvf3';

// ── Checkout ────────────────────────────────────────────────────────────────
describe('checkout', () => {
  it('unauthenticated → 401 and NO Stripe session created', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const r = await handleCheckout({ userId: null, email: 'a@x.com', plan: 'team', appUrl: APP, stripe });
    expect(r.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it('unknown plan → 400, no session', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const r = await handleCheckout({ userId: 'user_1', email: 'a@x.com', plan: 'enterprise', appUrl: APP, stripe });
    expect(r.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('authenticated → client_reference_id = clerk user_id; metadata carries clerk_user_id/plan; subscription_data.metadata set; email when no existing customer', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const r = await handleCheckout({ userId: 'user_1', email: 'a@x.com', plan: 'team', appUrl: APP, stripe });
    expect(r.status).toBe(200);
    const p = create.mock.calls[0][0];
    expect(p.client_reference_id).toBe('user_1');
    expect(p.metadata).toMatchObject({ clerk_user_id: 'user_1', plan: 'team' });
    expect(p.subscription_data.metadata.clerk_user_id).toBe('user_1');
    expect(p.subscription_data.trial_period_days).toBe(14);
    expect(p.customer_email).toBe('a@x.com');
    expect(p.line_items[0].price).toBe(PRICE_BY_PLAN.team);
  });

  it('reuses existing Stripe customer (no customer_email, no duplicate customer)', () => {
    const p = buildCheckoutParams({ userId: 'user_1', email: 'a@x.com', plan: 'pro', existingCustomer: 'cus_9', appUrl: APP });
    expect(p.customer).toBe('cus_9');
    expect(p.customer_email).toBeUndefined();
  });
});

// ── resolveClerkUserId ────────────────────────────────────────────────────────
describe('resolveClerkUserId', () => {
  it('prefers metadata.clerk_user_id', () => {
    expect(resolveClerkUserId({ clerk_user_id: 'user_meta' }, 'user_ref')).toBe('user_meta');
  });
  it('accepts a raw client_reference_id', () => {
    expect(resolveClerkUserId(null, 'user_raw')).toBe('user_raw');
  });
  it('parses the legacy v1_dashboard_upgrade token', () => {
    expect(resolveClerkUserId(null, 'v1_dashboard_upgrade_user_leg_miami_team_20260620')).toBe('user');
  });
  it('null when nothing usable', () => {
    expect(resolveClerkUserId(null, null)).toBeNull();
  });
});

// ── Webhook ───────────────────────────────────────────────────────────────────
function evt(type: string, object: any) { return JSON.stringify({ id: 'evt_1', type, data: { object } }); }
const emit = async () => {};

describe('webhook', () => {
  it('rejects invalid signature → 400 + alert, provisioning not attempted', async () => {
    const s = fakeStripe(); s.webhooks.constructEvent = vi.fn(() => { throw new Error('bad sig'); });
    const clerk = fakeClerk(); const alert = vi.fn();
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body: '{}', sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBe(400);
    expect(alert).toHaveBeenCalledWith('signature_verification_failed', expect.anything());
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();
  });

  it('provisions by Clerk user_id (metadata) and back-stamps Stripe metadata → 200', async () => {
    const s = fakeStripe({ clerk_user_id: 'user_meta' });
    const clerk = fakeClerk(); const alert = vi.fn();
    const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', customer_email: 'a@x.com', metadata: { clerk_user_id: 'user_meta' }, client_reference_id: null, id: 'cs_1' });
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBe(200);
    expect(clerk.updateUserMetadata).toHaveBeenCalledWith('user_meta', { publicMetadata: expect.objectContaining({ tier: 'team', counties_allowed: 99, billing_status: 'active' }) });
    expect(s._customersUpdate).toHaveBeenCalledWith('cus_1', { metadata: { clerk_user_id: 'user_meta' } });
    expect(s._subsUpdate).toHaveBeenCalledWith('sub_1', { metadata: { clerk_user_id: 'user_meta' } });
    expect(clerk.createUser).not.toHaveBeenCalled();
  });

  it('legacy event without clerk id → safe email fallback (create) + identity alert → 200', async () => {
    const s = fakeStripe({});  // no clerk_user_id in sub metadata
    const clerk = fakeClerk(); const alert = vi.fn();
    const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', customer_email: 'legacy@x.com', metadata: {}, client_reference_id: null, id: 'cs_1' });
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBe(200);
    expect(alert).toHaveBeenCalledWith('identity_missing_at_checkout', expect.anything());
    expect(clerk.createUser).toHaveBeenCalled();  // no existing user → created by email
  });

  it('idempotent: existing user updated (not duplicated) on repeated delivery', async () => {
    const s = fakeStripe({ clerk_user_id: 'user_meta' });
    const clerk = fakeClerk(); const alert = vi.fn();
    const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', customer_email: 'a@x.com', metadata: { clerk_user_id: 'user_meta' }, client_reference_id: null, id: 'cs_1' });
    await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(clerk.createUser).not.toHaveBeenCalled();          // never creates a duplicate
    expect(clerk.updateUserMetadata).toHaveBeenCalledTimes(2); // idempotent updates
  });

  it('missing identity (no clerk id AND no email) → non-2xx + PROVISIONING_ALERT', async () => {
    const s = fakeStripe({});
    s.customers.retrieve = vi.fn(async () => ({ email: null })) as any;  // no email anywhere
    const clerk = fakeClerk(); const alert = vi.fn();
    const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', customer_email: null, customer_details: {}, metadata: {}, client_reference_id: null, id: 'cs_1' });
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBeGreaterThanOrEqual(400);            // non-2xx → Stripe retries
    expect(alert).toHaveBeenCalledWith('no_email_no_identity', expect.anything());
  });

  it('CTA helper: signed-in → POSTs /api/checkout and navigates to the returned url', async () => {
    let posted: any = null; let navigatedTo = '';
    const fetchFn = (async (_u: string, opts: any) => { posted = JSON.parse(opts.body); return { status: 200, json: async () => ({ url: 'https://checkout.stripe/x' }) }; }) as any;
    const r = await startCheckout('team', { fetchFn, navigate: (u) => { navigatedTo = u; }, currentPath: '/dashboard' });
    expect(posted).toEqual({ plan: 'team' });
    expect(r.action).toBe('checkout');
    expect(navigatedTo).toBe('https://checkout.stripe/x');
  });

  it('CTA helper: unauthenticated (401) → routes to sign-in, no checkout url', async () => {
    let navigatedTo = '';
    const fetchFn = (async () => ({ status: 401, json: async () => ({}) })) as any;
    const r = await startCheckout('pro', { fetchFn, navigate: (u) => { navigatedTo = u; }, currentPath: '/pricing' });
    expect(r.action).toBe('signin');
    expect(navigatedTo).toContain('/sign-in?redirect_url=');
  });
});

describe('webhook (charge safety)', () => {
  it('does not create any Stripe charge or subscription (webhook never calls create endpoints)', async () => {
    const s: any = fakeStripe({ clerk_user_id: 'user_meta' });
    s.subscriptions.create = vi.fn(); s.checkout = { sessions: { create: vi.fn() } };
    const clerk = fakeClerk(); const alert = vi.fn();
    const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', customer_email: 'a@x.com', metadata: { clerk_user_id: 'user_meta' }, client_reference_id: null, id: 'cs_1' });
    await handleWebhook({ stripe: s, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(s.subscriptions.create).not.toHaveBeenCalled();
    expect(s.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

// ── Trial / pricing / entitlement invariants (must NOT change) ─────────────────
const CANONICAL_PRICE = {
  starter: 'price_1TMtSHIgaDPbFgUVPElPgL8V',
  pro: 'price_1TMtStIgaDPbFgUVPFOUjBMW',
  team: 'price_1TMtThIgaDPbFgUVoxIWlvf3',
} as const;

describe('trial & pricing invariants', () => {
  for (const plan of ['starter', 'pro', 'team'] as const) {
    it(`${plan}: Checkout Session has trial_period_days=14, the canonical Price ID, subscription mode, and no immediate charge`, () => {
      const p = buildCheckoutParams({ userId: 'user_1', email: 'a@x.com', plan, appUrl: APP });
      expect(p.subscription_data.trial_period_days).toBe(14);       // (1) 14-day trial
      expect(p.line_items[0].price).toBe(CANONICAL_PRICE[plan]);    // (2) correct existing Price ID
      expect(PRICE_BY_PLAN[plan]).toBe(CANONICAL_PRICE[plan]);
      expect(p.mode).toBe('subscription');                          // monthly subscription cadence
      expect((p as any).payment_intent_data).toBeUndefined();       // (3) no immediate one-time charge
    });
  }

  it('(3) handleCheckout creates only a Checkout Session — never a charge/paymentIntent', async () => {
    const create = vi.fn(async (params: any) => ({ url: 'u', _p: params }));
    const chargesCreate = vi.fn(); const piCreate = vi.fn();
    const stripe: any = { checkout: { sessions: { create } }, charges: { create: chargesCreate }, paymentIntents: { create: piCreate } };
    await handleCheckout({ userId: 'user_1', email: 'a@x.com', plan: 'team', appUrl: APP, stripe });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].subscription_data.trial_period_days).toBe(14);
    expect(chargesCreate).not.toHaveBeenCalled();
    expect(piCreate).not.toHaveBeenCalled();
  });

  it('(4) trialing subscription is provisioned immediately (billing_status active) on checkout.session.completed', async () => {
    const s = fakeStripe({ clerk_user_id: 'user_t' });  // subscriptions.retrieve → status 'trialing'
    const clerk = fakeClerk(); const alert = vi.fn();
    const body = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', customer_email: 'a@x.com', metadata: { clerk_user_id: 'user_t' }, client_reference_id: null, id: 'cs_1' });
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBe(200);
    expect(clerk.updateUserMetadata).toHaveBeenCalledWith('user_t', { publicMetadata: expect.objectContaining({ tier: 'team', counties_allowed: 99, billing_status: 'active' }) });
  });

  it('(5) trial→active conversion preserves the SAME Clerk tier/access', async () => {
    const clerk = fakeClerk(); const alert = vi.fn();
    const sTrial = fakeStripe({ clerk_user_id: 'user_t' });   // team price
    const sPaid = fakeStripe({ clerk_user_id: 'user_t' });    // same team price on conversion
    const trialBody = evt('checkout.session.completed', { subscription: 'sub_1', customer: 'cus_1', customer_email: 'a@x.com', metadata: { clerk_user_id: 'user_t' }, client_reference_id: null, id: 'cs_1' });
    const paidBody = evt('invoice.payment_succeeded', { subscription: 'sub_1', amount_paid: 29900, customer_email: 'a@x.com', id: 'in_1' });
    await handleWebhook({ stripe: sTrial as any, clerk: clerk as any, body: trialBody, sig: 'x', secret: 'sec', emit, alert });
    await handleWebhook({ stripe: sPaid as any, clerk: clerk as any, body: paidBody, sig: 'x', secret: 'sec', emit, alert });
    const tiersWritten = clerk.updateUserMetadata.mock.calls.map((c: any) => c[1].publicMetadata.tier);
    expect(tiersWritten).toEqual(['team', 'team']);  // tier unchanged across trial → paid
    expect(clerk.createUser).not.toHaveBeenCalled();
  });
});
