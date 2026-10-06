// Regression test for the replay runner's payment-method fixture. The fake mimics the real Stripe
// behaviour that broke the first run: a test token (pm_card_visa) is NOT the id of the PaymentMethod
// that gets attached; attach() returns a new PaymentMethod with its own id.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { attachCard, assertDefaultPaymentMethodAttached } from '../scripts/stripe-replay-fixtures';

// ---- Runner cleanup semantics (see the last describe block): the REAL scripts/stripe-test-replay.ts is imported with
// in-memory Stripe/Clerk fakes, so we can prove cleanup runs after failed scenarios without touching any network.
const h = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_replay_cleanup_dummy';
  process.env.CLERK_SECRET_KEY = 'sk_test_replay_cleanup_dummy';
  return { world: null as any };
});
vi.mock('stripe', () => ({ default: class { constructor() { return h.world.stripe; } } }));
vi.mock('@clerk/backend', () => ({ createClerkClient: () => h.world.clerk }));
vi.mock('../lib/provisioning', () => ({ handleWebhook: async () => ({ status: 200, body: {} }), PRICE_TO_TIER: {} }));
vi.mock('../lib/webhook-clients', () => ({ wrapClerkWithRateLimitRetry: (c: any) => c, wrapStripeWithIdempotentMapping: (s: any) => s }));

function fakeStripe(opts: { attachReturnsWrongCustomer?: boolean } = {}) {
  const pms = new Map<string, { id: string; customer: string | null }>();
  const customers = new Map<string, any>();
  let n = 0;
  return {
    customers: {
      retrieve: async (id: string) => customers.get(id) || (customers.set(id, { id, invoice_settings: {} }), customers.get(id)),
      update: async (id: string, p: any) => {
        const c = await (async () => customers.get(id) || (customers.set(id, { id, invoice_settings: {} }), customers.get(id)))();
        const ref = p.invoice_settings?.default_payment_method;
        // Real Stripe rejects a default that is not attached to this customer.
        if (ref && pms.get(ref)?.customer !== id) throw new Error('The payment method must be attached to the customer.');
        c.invoice_settings = { ...c.invoice_settings, ...p.invoice_settings };
        return c;
      },
    },
    paymentMethods: {
      attach: async (_token: string, p: { customer: string }) => {
        const pm = { id: `pm_att_${++n}`, customer: opts.attachReturnsWrongCustomer ? 'cus_other' : p.customer };
        pms.set(pm.id, pm); return pm;
      },
      retrieve: async (id: string) => pms.get(id) || { id, customer: null }, // bare tokens are unattached
    },
    _customers: customers,
  };
}

describe('replay fixture: payment method must be attached to the customer', () => {
  it('attachCard returns the ATTACHED payment method id (not the token) and makes it the default', async () => {
    const s = fakeStripe();
    const id = await attachCard(s as any, 'cus_1', 'pm_card_visa');
    expect(id).not.toBe('pm_card_visa');
    expect((await s.customers.retrieve('cus_1')).invoice_settings.default_payment_method).toBe(id);
  });

  it('assertDefaultPaymentMethodAttached passes after attachCard (payment_method.customer === customer.id)', async () => {
    const s = fakeStripe();
    const id = await attachCard(s as any, 'cus_1', 'pm_card_visa');
    await expect(assertDefaultPaymentMethodAttached(s as any, 'cus_1')).resolves.toBe(id);
  });

  it('the original bug pattern (literal token used as default) is rejected', async () => {
    const s = fakeStripe();
    await s.paymentMethods.attach('pm_card_visa', { customer: 'cus_1' });
    await expect(s.customers.update('cus_1', { invoice_settings: { default_payment_method: 'pm_card_visa' } }))
      .rejects.toThrow(/must be attached to the customer/);
  });

  it('assertion fails closed when the default payment method is missing or belongs to another customer', async () => {
    const s = fakeStripe();
    await expect(assertDefaultPaymentMethodAttached(s as any, 'cus_1')).rejects.toThrow(/no default payment method/);
    s._customers.set('cus_2', { id: 'cus_2', invoice_settings: { default_payment_method: 'pm_card_visa' } }); // bare token
    await expect(assertDefaultPaymentMethodAttached(s as any, 'cus_2')).rejects.toThrow(/payment_method\.customer/);
  });

  it('attachCard throws if Stripe attaches the method to a different customer', async () => {
    const s = fakeStripe({ attachReturnsWrongCustomer: true });
    await expect(attachCard(s as any, 'cus_1', 'pm_card_visa')).rejects.toThrow(/fixture invariant violated/);
  });
});

// In-memory Stripe test-mode + Clerk dev fakes. Like real Stripe, cancelling an already-canceled subscription throws.
function makeWorld(opts: { failSubscriptionCreateOnCall?: number; failSubscriptionCancel?: boolean; failPriceCreateOnCall?: number } = {}) {
  const st = { users: new Map<string, boolean>(), customers: new Map<string, boolean>(), subs: new Map<string, string>(), clocks: new Map<string, boolean>(), pms: new Map<string, string>() };
  let n = 0; let subCalls = 0; let priceCalls = 0;
  const id = (p: string) => `${p}_${++n}`;
  const stripe: any = {
    webhooks: { generateTestHeaderString: () => 'sig' },
    products: { create: async () => ({ id: id('prod') }) },
    prices: { create: async () => { if (opts.failPriceCreateOnCall && ++priceCalls === opts.failPriceCreateOnCall) throw new Error('boom: prices.create'); return { id: id('price') }; } },
    customers: {
      create: async (p: any) => { const c = id('cus'); st.customers.set(c, false); return { id: c, ...p, invoice_settings: {} }; },
      retrieve: async (c: string) => ({ id: c, invoice_settings: { default_payment_method: [...st.pms].find(([, cu]) => cu === c)?.[0] } }),
      update: async (c: string) => ({ id: c }),
      del: async (c: string) => { if (st.customers.get(c)) throw new Error('already deleted'); st.customers.set(c, true); return { id: c, deleted: true }; },
    },
    paymentMethods: {
      attach: async (_t: string, p: { customer: string }) => { const pm = id('pm'); st.pms.set(pm, p.customer); return { id: pm, customer: p.customer }; },
      retrieve: async (pm: string) => ({ id: pm, customer: st.pms.get(pm) }),
    },
    subscriptions: {
      create: async (p: any) => { if (opts.failSubscriptionCreateOnCall && ++subCalls === opts.failSubscriptionCreateOnCall) throw new Error('boom: subscriptions.create'); const sId = id('sub'); st.subs.set(sId, 'active'); return { id: sId, status: 'active', customer: p.customer, metadata: p.metadata, items: { data: [] } }; },
      retrieve: async (sId: string) => ({ id: sId, status: st.subs.get(sId) }),
      update: async (sId: string) => ({ id: sId, status: st.subs.get(sId) }),
      cancel: async (sId: string) => { if (opts.failSubscriptionCancel) throw new Error('boom: subscriptions.cancel'); if (st.subs.get(sId) === 'canceled') throw new Error('already canceled'); st.subs.set(sId, 'canceled'); return { id: sId, status: 'canceled' }; },
    },
    invoices: { list: async () => ({ data: [{ id: 'in_1', amount_paid: 100, created: 1 }] }), retrieve: async (i: string) => ({ id: i }), pay: async () => ({}) },
    testHelpers: { testClocks: {
      create: async () => { const c = id('clock'); st.clocks.set(c, false); return { id: c, frozen_time: 1000 }; },
      retrieve: async (c: string) => ({ id: c, frozen_time: 1000, status: 'ready' }),
      advance: async () => ({}),
      del: async (c: string) => { st.clocks.set(c, true); return {}; },
    } },
  };
  const clerk: any = { users: {
    createUser: async () => { const u = id('user'); st.users.set(u, false); return { id: u }; },
    getUser: async () => ({ publicMetadata: {} }), // never entitled -> every scenario assertion fails
    deleteUser: async (u: string) => { st.users.set(u, true); return {}; },
  } };
  return { stripe, clerk, st };
}

async function runRunner(world: ReturnType<typeof makeWorld>) {
  h.world = world;
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The runner sleeps 2s-65s between polls; make those instant (short timers stay real).
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...a: any[]) => (ms && ms >= 1000 ? (Promise.resolve().then(() => fn(...a)), 0 as any) : real(fn, ms, ...a))) as any);
  const exited = new Promise<number>(res => { vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { res(c ?? 0); return undefined as never; }) as any); });
  await import('../scripts/stripe-test-replay');
  return exited;
}
const leaked = (st: ReturnType<typeof makeWorld>['st']) => ({
  users: [...st.users].filter(([, d]) => !d).map(([k]) => k),
  customers: [...st.customers].filter(([, d]) => !d).map(([k]) => k),
  clocks: [...st.clocks].filter(([, d]) => !d).map(([k]) => k),
  subs: [...st.subs].filter(([, status]) => status !== 'canceled').map(([k]) => k),
});

describe('replay runner cleanup semantics (real runner, in-memory Stripe/Clerk)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('scenario assertion failures: exits 1 and every created user/customer/subscription/test clock is still cleaned up', async () => {
    const w = makeWorld();
    const code = await runRunner(w);
    expect(code).toBe(1);
    // non-vacuous: the failing scenarios really created objects before they failed
    expect(w.st.users.size).toBeGreaterThanOrEqual(8); expect(w.st.customers.size).toBeGreaterThanOrEqual(8);
    expect(w.st.subs.size).toBeGreaterThanOrEqual(8); expect(w.st.clocks.size).toBeGreaterThanOrEqual(2);
    expect(leaked(w.st)).toEqual({ users: [], customers: [], clocks: [], subs: [] });
  });

  it('mid-scenario infrastructure failure (subscriptions.create throws after the user and customer exist): nothing leaks', async () => {
    const w = makeWorld({ failSubscriptionCreateOnCall: 3 });
    const code = await runRunner(w);
    expect(code).toBe(1);
    expect(leaked(w.st)).toEqual({ users: [], customers: [], clocks: [], subs: [] });
  });

  it('a failing cleanup call (subscriptions.cancel always throws) does not stop the remaining cleanup', async () => {
    const w = makeWorld({ failSubscriptionCancel: true });
    const code = await runRunner(w);
    expect(code).toBe(1);
    const l = leaked(w.st);
    expect(l.users).toEqual([]); expect(l.customers).toEqual([]); expect(l.clocks).toEqual([]);
  });

  it('a fatal error outside any scenario (catalog creation fails) still exits non-zero through the cleanup path', async () => {
    const w = makeWorld({ failPriceCreateOnCall: 2 });
    const code = await runRunner(w);
    expect(code).toBe(1);
    expect(leaked(w.st)).toEqual({ users: [], customers: [], clocks: [], subs: [] });
  });
});
