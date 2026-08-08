// Duplicate-subscription / idempotency guard (highest financial risk).
// Covers the primary checkout-create block (409 → Manage Billing) and the webhook backstop
// that refuses to clobber an existing active binding with a different subscription.
import { describe, it, expect, vi } from 'vitest';
import { handleCheckout } from '../lib/checkout-session';
import { handleWebhook } from '../lib/provisioning';
import { startCheckout } from '../lib/start-checkout';

const APP = 'https://app.permitmap.org';
const PRO = 'price_1TMtStIgaDPbFgUVPFOUjBMW';

function fakeStripeCheckout(listData?: Array<{ status: string }>) {
  const create = vi.fn(async (params: any) => ({ url: 'https://checkout.stripe.test/x', _params: params }));
  const list = vi.fn(async (_p: any) => ({ data: listData || [] }));
  const stripe: any = { checkout: { sessions: { create } } };
  if (listData !== undefined) stripe.subscriptions = { list };
  return { create, list, stripe };
}

// ── checkout-create guard ─────────────────────────────────────────────────────
describe('checkout duplicate guard', () => {
  it('BLOCKS (409, no session) when Clerk metadata shows an active subscription', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const r = await handleCheckout({
      userId: 'user_1', email: 'a@x.com', plan: 'pro', appUrl: APP, stripe,
      existingSubscriptionId: 'sub_existing', billingStatus: 'active',
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'active_subscription_exists', manage_billing: true });
    expect(create).not.toHaveBeenCalled();
  });

  it('BLOCKS (409) when Stripe authoritatively reports a live subscription (stale/missing Clerk metadata)', async () => {
    const { create, list, stripe } = fakeStripeCheckout([{ status: 'active' }]);
    const r = await handleCheckout({
      userId: 'user_1', email: 'a@x.com', plan: 'pro', appUrl: APP, stripe,
      existingCustomer: 'cus_1', // no billingStatus/subId → falls through to authoritative Stripe check
    });
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 });
    expect(r.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it('ALLOWS checkout when the only subs are cancelled/incomplete (no live plan)', async () => {
    const { create, stripe } = fakeStripeCheckout([{ status: 'canceled' }, { status: 'incomplete_expired' }]);
    const r = await handleCheckout({
      userId: 'user_1', email: 'a@x.com', plan: 'pro', appUrl: APP, stripe, existingCustomer: 'cus_1',
    });
    expect(r.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ALLOWS a first-time buyer (no customer, no active plan) — guard is inert', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const r = await handleCheckout({ userId: 'user_1', email: 'a@x.com', plan: 'pro', appUrl: APP, stripe });
    expect(r.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('client startCheckout maps 409 → active_subscription (routes to Manage Billing, no checkout nav)', async () => {
    const nav = vi.fn();
    const fetchFn = vi.fn(async () => ({ status: 409, json: async () => ({ code: 'active_subscription_exists' }) })) as any;
    const r = await startCheckout('pro', { fetchFn, navigate: nav, currentPath: '/dashboard' });
    expect(r.action).toBe('active_subscription');
    expect(nav).toHaveBeenCalledWith('/dashboard?billing=manage');
  });
});

// ── webhook backstop ────────────────────────────────────────────────────────────
function evt(type: string, object: any) { return JSON.stringify({ id: 'evt_1', type, data: { object } }); }
const emit = async () => {};

function webhookStripe(subId: string, price = PRO) {
  const customersUpdate = vi.fn(async () => ({}));
  const subsUpdate = vi.fn(async () => ({}));
  return {
    _customersUpdate: customersUpdate, _subsUpdate: subsUpdate,
    subscriptions: {
      retrieve: vi.fn(async (_id: string) => ({ items: { data: [{ price: { id: price } }] }, metadata: { clerk_user_id: 'user_dup' }, status: 'active', customer: 'cus_new', id: subId })),
      update: subsUpdate,
    },
    customers: { retrieve: vi.fn(async () => ({ email: 'a@x.com' })), update: customersUpdate },
    webhooks: { constructEvent: vi.fn((b: string) => JSON.parse(b)) },
  };
}

function clerkWith(publicMetadata: Record<string, any> | null) {
  const updateUserMetadata = vi.fn(async () => ({}));
  const createUser = vi.fn(async () => ({ id: 'user_created' }));
  const getUserList = vi.fn(async () => ({ totalCount: 0, data: [] as any[] }));
  const getUser = vi.fn(async () => ({ publicMetadata }));
  return { updateUserMetadata, createUser, getUserList, getUser, users: { updateUserMetadata, createUser, getUserList, getUser } };
}

describe('webhook duplicate backstop', () => {
  it('REFUSES to overwrite when a DIFFERENT active subscription is already bound → alert, binding protected', async () => {
    const s = webhookStripe('sub_new');
    const clerk = clerkWith({ billing_status: 'active', stripe_subscription_id: 'sub_original', tier: 'pro' });
    const alert = vi.fn();
    const body = evt('customer.subscription.created', { id: 'sub_new', customer: 'cus_new', metadata: { clerk_user_id: 'user_dup' }, items: { data: [{ price: { id: PRO } }] } });
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBe(200);
    expect(alert).toHaveBeenCalledWith('duplicate_subscription', expect.objectContaining({
      existing_subscription_id: 'sub_original', new_subscription_id: 'sub_new', clerk_user_id: 'user_dup',
    }));
    expect(clerk.updateUserMetadata).not.toHaveBeenCalled();   // original entitlement untouched
    expect(s._subsUpdate).toHaveBeenCalledWith('sub_new', { metadata: { clerk_user_id: 'user_dup' } }); // traceability stamp
  });

  it('PROVISIONS normally on the SAME sub id (trial→paid / re-delivery is not a duplicate)', async () => {
    const s = webhookStripe('sub_same');
    const clerk = clerkWith({ billing_status: 'active', stripe_subscription_id: 'sub_same', tier: 'pro' });
    const alert = vi.fn();
    const body = evt('customer.subscription.updated', { id: 'sub_same', customer: 'cus_new', metadata: { clerk_user_id: 'user_dup' }, items: { data: [{ price: { id: PRO } }] } });
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBe(200);
    expect(alert).not.toHaveBeenCalledWith('duplicate_subscription', expect.anything());
    expect(clerk.updateUserMetadata).toHaveBeenCalledTimes(1);
  });

  it('PROVISIONS after a prior CANCELLED sub (resubscribe is not a duplicate)', async () => {
    const s = webhookStripe('sub_new2');
    const clerk = clerkWith({ billing_status: 'cancelled', stripe_subscription_id: 'sub_old', tier: 'cancelled' });
    const alert = vi.fn();
    const body = evt('customer.subscription.created', { id: 'sub_new2', customer: 'cus_new', metadata: { clerk_user_id: 'user_dup' }, items: { data: [{ price: { id: PRO } }] } });
    const r = await handleWebhook({ stripe: s as any, clerk: clerk as any, body, sig: 'x', secret: 'sec', emit, alert });
    expect(r.status).toBe(200);
    expect(alert).not.toHaveBeenCalledWith('duplicate_subscription', expect.anything());
    expect(clerk.updateUserMetadata).toHaveBeenCalledTimes(1);
  });
});
