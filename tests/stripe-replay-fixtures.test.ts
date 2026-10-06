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

// In-memory Stripe test-mode + Clerk dev fakes. Like real Stripe, a subscription that is already canceled cannot be canceled again.
type WorldOpts = {
  failSubscriptionCreateOnCall?: number; failSubscriptionCancel?: boolean; failPriceCreateOnCall?: number;
  failPriceArchiveOnCall?: number; failCustomerDeleteOnCall?: number; onCustomerCreate?: (n: number) => void;
};
function makeWorld(opts: WorldOpts = {}) {
  const st = {
    users: new Map<string, boolean>(), customers: new Map<string, boolean>(), subs: new Map<string, string>(), clocks: new Map<string, boolean>(),
    pms: new Map<string, string>(), prices: new Map<string, boolean>(), products: new Map<string, boolean>(), // price/product value = still ACTIVE
    ops: [] as string[], // every cleanup-type call, e.g. "deleteUser:user_3"
  };
  let n = 0; let subCalls = 0; let priceCalls = 0; let custCalls = 0; let archiveCalls = 0; let custDelCalls = 0;
  const id = (p: string) => `${p}_${++n}`;
  const stripe: any = {
    webhooks: { generateTestHeaderString: () => 'sig' },
    products: {
      create: async () => { const i = id('prod'); st.products.set(i, true); return { id: i }; },
      update: async (i: string, p: any) => { st.ops.push(`archiveProduct:${i}`); if (p.active === false) st.products.set(i, false); return { id: i }; },
    },
    prices: {
      create: async () => { if (opts.failPriceCreateOnCall && ++priceCalls === opts.failPriceCreateOnCall) throw new Error('boom: prices.create'); const i = id('price'); st.prices.set(i, true); return { id: i }; },
      update: async (i: string, p: any) => { st.ops.push(`archivePrice:${i}`); if (opts.failPriceArchiveOnCall && ++archiveCalls === opts.failPriceArchiveOnCall) throw new Error('boom: prices.update'); if (p.active === false) st.prices.set(i, false); return { id: i }; },
    },
    customers: {
      create: async (p: any) => { const c = id('cus'); st.customers.set(c, false); opts.onCustomerCreate?.(++custCalls); return { id: c, ...p, invoice_settings: {} }; },
      retrieve: async (c: string) => ({ id: c, invoice_settings: { default_payment_method: [...st.pms].find(([, cu]) => cu === c)?.[0] } }),
      update: async (c: string) => ({ id: c }),
      del: async (c: string) => { st.ops.push(`deleteCustomer:${c}`); if (opts.failCustomerDeleteOnCall && ++custDelCalls === opts.failCustomerDeleteOnCall) throw new Error('boom: customers.del'); if (st.customers.get(c)) throw Object.assign(new Error('no such customer'), { code: 'resource_missing' }); st.customers.set(c, true); return { id: c, deleted: true }; },
    },
    paymentMethods: {
      attach: async (_t: string, p: { customer: string }) => { const pm = id('pm'); st.pms.set(pm, p.customer); return { id: pm, customer: p.customer }; },
      retrieve: async (pm: string) => ({ id: pm, customer: st.pms.get(pm) }),
    },
    subscriptions: {
      create: async (p: any) => { if (opts.failSubscriptionCreateOnCall && ++subCalls === opts.failSubscriptionCreateOnCall) throw new Error('boom: subscriptions.create'); const sId = id('sub'); st.subs.set(sId, 'active'); return { id: sId, status: 'active', customer: p.customer, metadata: p.metadata, items: { data: [] } }; },
      retrieve: async (sId: string) => ({ id: sId, status: st.subs.get(sId) }),
      update: async (sId: string) => ({ id: sId, status: st.subs.get(sId) }),
      cancel: async (sId: string) => { st.ops.push(`cancelSub:${sId}`); if (opts.failSubscriptionCancel) throw new Error('boom: subscriptions.cancel'); if (st.subs.get(sId) === 'canceled') throw new Error('already canceled'); st.subs.set(sId, 'canceled'); return { id: sId, status: 'canceled' }; },
    },
    invoices: { list: async () => ({ data: [{ id: 'in_1', amount_paid: 100, created: 1 }] }), retrieve: async (i: string) => ({ id: i }), pay: async () => ({}) },
    testHelpers: { testClocks: {
      create: async () => { const c = id('clock'); st.clocks.set(c, false); return { id: c, frozen_time: 1000 }; },
      retrieve: async (c: string) => ({ id: c, frozen_time: 1000, status: 'ready' }),
      advance: async () => ({}),
      del: async (c: string) => { st.ops.push(`deleteClock:${c}`); st.clocks.set(c, true); return {}; },
    } },
  };
  const clerk: any = { users: {
    createUser: async () => { const u = id('user'); st.users.set(u, false); return { id: u }; },
    getUser: async () => ({ publicMetadata: {} }), // never entitled -> every scenario assertion fails
    deleteUser: async (u: string) => { st.ops.push(`deleteUser:${u}`); st.users.set(u, true); return {}; },
  } };
  return { stripe, clerk, st };
}

// Signal handlers the runner installs are called directly (never process.emit: that would also fire the test runner's own handlers).
const baseline = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
const sendSignal = (sig: 'SIGINT' | 'SIGTERM') => { for (const l of process.listeners(sig)) if (!baseline[sig].includes(l)) (l as any)(sig); };
const dropRunnerSignalHandlers = () => { for (const sig of ['SIGINT', 'SIGTERM'] as const) for (const l of process.listeners(sig)) if (!baseline[sig].includes(l)) process.removeListener(sig, l); };

async function runRunner(world: ReturnType<typeof makeWorld>) {
  h.world = world;
  vi.resetModules();
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The runner sleeps 2s-65s between polls; make those instant (short timers stay real).
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...a: any[]) => (ms && ms >= 1000 ? (Promise.resolve().then(() => fn(...a)), 0 as any) : real(fn, ms, ...a))) as any);
  const exitCalls: number[] = [];
  const exited = new Promise<number>(res => { vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { exitCalls.push(c ?? 0); res(exitCalls[0]); return undefined as never; }) as any); });
  await import('../scripts/stripe-test-replay');
  return { code: await exited, logs, exitCalls };
}
const leaked = (st: ReturnType<typeof makeWorld>['st']) => ({
  users: [...st.users].filter(([, d]) => !d).map(([k]) => k),
  customers: [...st.customers].filter(([, d]) => !d).map(([k]) => k),
  clocks: [...st.clocks].filter(([, d]) => !d).map(([k]) => k),
  subs: [...st.subs].filter(([, status]) => status !== 'canceled').map(([k]) => k),
  prices: [...st.prices].filter(([, active]) => active).map(([k]) => k),
  products: [...st.products].filter(([, active]) => active).map(([k]) => k),
});
const NOTHING = { users: [], customers: [], clocks: [], subs: [], prices: [], products: [] };

describe('replay runner cleanup semantics (real runner, in-memory Stripe/Clerk)', () => {
  afterEach(() => { vi.restoreAllMocks(); dropRunnerSignalHandlers(); });

  it('scenario assertion failures: exits 1 and every created user/customer/subscription/test clock/price/product is still cleaned up', async () => {
    const w = makeWorld();
    const { code } = await runRunner(w);
    expect(code).toBe(1);
    // non-vacuous: the failing scenarios really created objects before they failed
    expect(w.st.users.size).toBeGreaterThanOrEqual(8); expect(w.st.customers.size).toBeGreaterThanOrEqual(8);
    expect(w.st.subs.size).toBeGreaterThanOrEqual(8); expect(w.st.clocks.size).toBeGreaterThanOrEqual(2);
    expect(w.st.prices.size).toBe(4); expect(w.st.products.size).toBe(1);
    expect(leaked(w.st)).toEqual(NOTHING);
  });

  it('prices are archived before their product', async () => {
    const w = makeWorld();
    await runRunner(w);
    const archives = w.st.ops.filter(o => o.startsWith('archive'));
    expect(archives.filter(o => o.startsWith('archivePrice')).length).toBe(4);
    expect(archives[archives.length - 1]).toMatch(/^archiveProduct:/);
  });

  it('mid-scenario infrastructure failure (subscriptions.create throws after the user and customer exist): nothing leaks', async () => {
    const w = makeWorld({ failSubscriptionCreateOnCall: 3 });
    const { code } = await runRunner(w);
    expect(code).toBe(1);
    expect(leaked(w.st)).toEqual(NOTHING);
  });

  it('a failing cleanup operation does not stop the rest, is reported, and the run exits non-zero', async () => {
    // every subscription cancel throws, the first price archive throws, the first customer delete throws
    const w = makeWorld({ failSubscriptionCancel: true, failPriceArchiveOnCall: 1, failCustomerDeleteOnCall: 1 });
    const { code, logs } = await runRunner(w);
    expect(code).toBe(1);
    const l = leaked(w.st);
    expect(l.users).toEqual([]); expect(l.clocks).toEqual([]);
    expect(l.customers.length).toBe(1); expect(l.prices.length).toBe(1); // only the ones whose own operation failed
    expect(l.products).toEqual([]); // product archive still ran after a price archive failed
    expect(logs.some(m => m.includes('CLEANUP FAILED'))).toBe(true);
  });

  it('a fatal error outside any scenario (catalog creation fails) exits non-zero and archives what was already created', async () => {
    const w = makeWorld({ failPriceCreateOnCall: 2 });
    const { code } = await runRunner(w);
    expect(code).toBe(1);
    expect(w.st.prices.size).toBe(1); expect(w.st.products.size).toBe(1); // created, then tracked
    expect(leaked(w.st)).toEqual(NOTHING);
  });

  it('SIGINT after several objects exist: stops early, cleans users, customers, subscriptions, clocks and catalog, exits 130', async () => {
    const w = makeWorld({ onCustomerCreate: n => { if (n === 4) sendSignal('SIGINT'); } });
    const { code, logs } = await runRunner(w);
    expect(code).toBe(130);
    // non-vacuous and prompt: four customers existed when the signal arrived and no fifth was created afterwards
    expect(w.st.customers.size).toBe(4); expect(w.st.users.size).toBe(4); expect(w.st.subs.size).toBeGreaterThanOrEqual(3); expect(w.st.clocks.size).toBeGreaterThanOrEqual(2);
    expect(w.st.prices.size).toBe(4); expect(w.st.products.size).toBe(1);
    expect(leaked(w.st)).toEqual(NOTHING);
    expect(logs.some(m => m.includes('INTERRUPTED (SIGINT)'))).toBe(true);
  });

  it('SIGTERM is handled the same way and exits 143', async () => {
    const w = makeWorld({ onCustomerCreate: n => { if (n === 2) sendSignal('SIGTERM'); } });
    const { code } = await runRunner(w);
    expect(code).toBe(143);
    expect(w.st.customers.size).toBe(2);
    expect(leaked(w.st)).toEqual(NOTHING);
  });

  it('an interrupt combined with failing cleanup operations still cleans the rest and keeps the interrupt exit code', async () => {
    const w = makeWorld({ failSubscriptionCancel: true, failPriceArchiveOnCall: 1, onCustomerCreate: n => { if (n === 4) sendSignal('SIGINT'); } });
    const { code } = await runRunner(w);
    expect(code).toBe(130);
    const l = leaked(w.st);
    expect(l.users).toEqual([]); expect(l.customers).toEqual([]); expect(l.clocks).toEqual([]); expect(l.products).toEqual([]);
    expect(l.prices.length).toBe(1);
  });

  it('cleanup runs at most once even if the signal arrives twice', async () => {
    const w = makeWorld({ onCustomerCreate: n => { if (n === 4) { sendSignal('SIGINT'); sendSignal('SIGINT'); } } });
    const { code, exitCalls } = await runRunner(w);
    expect(code).toBe(130); // the second signal force-exits immediately (mocked here, so the run keeps going and we can inspect what cleanup did)
    await vi.waitFor(() => expect(exitCalls.length).toBe(2)); // normal finish path reached its own exit after cleanup
    expect(exitCalls).toEqual([130, 130]);
    const cleanupOps = w.st.ops.filter(o => !o.startsWith('cancelSub')); // cancelSub is guarded by a status read; the rest must be unique
    expect(new Set(cleanupOps).size).toBe(cleanupOps.length);
    expect(w.st.ops.filter(o => o.startsWith('cancelSub')).length).toBe(new Set(w.st.ops.filter(o => o.startsWith('cancelSub'))).size);
    expect(leaked(w.st)).toEqual(NOTHING);
  });
});
