import { describe, it, expect, vi } from 'vitest';
import { handleCheckout, buildCheckoutParams, PRICE_BY_PLAN } from '../lib/checkout-session';
import { handleWebhook, resolveClerkUserId, PRICE_TO_TIER } from '../lib/provisioning';

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
