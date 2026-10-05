// Adversarial regression suite for Stripe → Clerk entitlement (lib/provisioning.ts).
// Everything runs against in-memory fakes: NO live Stripe or Clerk call is ever made. The fake Stripe
// holds the authoritative subscription state; the fake Clerk stores publicMetadata with real
// Clerk-style top-level merge semantics. After every scenario the Clerk entitlement is compared with
// what Stripe truth says it should be.
import { describe, it, expect } from 'vitest';
import { handleStripeEvent, handleWebhook } from '../lib/provisioning';
import { makeWorld, ev, subObj, PRICE, truthEntitlement, clerkEntitlement, core } from './_entitlement-harness';

const U = 'user_1';

async function deliver(w: ReturnType<typeof makeWorld>, e: any) {
  await handleStripeEvent(w.stripe as any, w.clerk as any, e, { emit: w.emit, alert: w.alert });
}

describe('1. entitlement truth — non-entitled states are never stamped active', () => {
  for (const [status, expectBilling, expectTier] of [
    ['canceled', 'cancelled', 'cancelled'],
    ['unpaid', 'unpaid', 'cancelled'],
    ['incomplete_expired', 'incomplete_expired', 'cancelled'],
    ['past_due', 'past_due', 'pro'],
  ] as const) {
    it(`${status}: user previously active ends with billing_status=${expectBilling}, tier=${expectTier} (never 'active')`, async () => {
      const w = makeWorld();
      w.setSub('sub_A', { status: 'active', price: PRICE.pro });
      await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
      expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active' });
      w.setSub('sub_A', { status });
      await deliver(w, ev('customer.subscription.updated', w.sub('sub_A'), 20));
      const c = clerkEntitlement(w, U);
      expect(c.billing).toBe(expectBilling);
      expect(c.tier).toBe(expectTier);
      expect(c.billing).not.toBe('active');
      expect(core(c)).toEqual(truthEntitlement(w, U));
    });
  }

  it('incomplete NEVER grants (new customer): no Clerk write, no emit', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'incomplete', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    expect(w.clerkWrites()).toBe(0);
    expect(clerkEntitlement(w, U).tier).toBeUndefined();
  });

  it('checkout.session.completed with an incomplete subscription grants nothing and emits no trial_started', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'incomplete', price: PRICE.pro });
    await deliver(w, ev('checkout.session.completed', { id: 'cs_1', subscription: 'sub_A', customer: 'cus_1', customer_email: 'a@x.com', client_reference_id: U, metadata: { clerk_user_id: U } }, 10));
    expect(w.clerkWrites()).toBe(0);
    expect(w.emits.filter(e => e.name === 'trial_started')).toHaveLength(0);
  });

  it('trialing is entitled and keeps billing_status "active" exactly as before (raw status recorded separately)', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'trialing', price: PRICE.starter });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'starter', billing: 'active', rawStatus: 'trialing' });
  });

  it('paused interlock (pause_collection) still stamps billing_status=paused and keeps access (unchanged behavior)', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro, pause_collection: { behavior: 'void' } });
    await deliver(w, ev('customer.subscription.updated', w.sub('sub_A'), 10));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'paused' });
  });
});

describe('2. duplicate subscriptions', () => {
  it('active A bound; duplicate B created then CANCELED → A access untouched', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_B', { status: 'active', price: PRICE.pro, customer: 'cus_2' });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_B'), 20));
    expect(clerkEntitlement(w, U).subId).toBe('sub_A'); // guard protected the binding
    w.setSub('sub_B', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_B'), 30));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active', subId: 'sub_A' });
    expect(core(clerkEntitlement(w, U))).toEqual(truthEntitlement(w, U));
  });

  it('the BOUND subscription is cancelled while a valid duplicate remains → duplicate is promoted, access NOT revoked', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.starter });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_B', { status: 'active', price: PRICE.pro, customer: 'cus_2' });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_B'), 20));
    w.setSub('sub_A', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 30));
    const c = clerkEntitlement(w, U);
    expect(c).toMatchObject({ tier: 'pro', billing: 'active', subId: 'sub_B' });
    expect(w.alerts.map(a => a.kind)).toContain('duplicate_subscription_promoted');
    expect(core(c)).toEqual(truthEntitlement(w, U));
  });

  it('both subscriptions end → access is revoked only when no valid subscription remains', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_B', { status: 'active', price: PRICE.pro, customer: 'cus_2' });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_B'), 20));
    w.setSub('sub_B', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_B'), 30));
    w.setSub('sub_A', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 40));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'cancelled', billing: 'cancelled' });
    expect(core(clerkEntitlement(w, U))).toEqual(truthEntitlement(w, U));
  });

  it('a duplicate that is past_due/canceled does not block or downgrade the healthy bound subscription', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.team });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_B', { status: 'past_due', price: PRICE.starter, customer: 'cus_2' });
    await deliver(w, ev('customer.subscription.updated', w.sub('sub_B'), 20));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'team', billing: 'active', subId: 'sub_A' });
  });

  it('promotion read path is read-only: Stripe is never mutated except metadata mapping', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_B', { status: 'active', price: PRICE.pro, customer: 'cus_2' });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_B'), 20));
    w.setSub('sub_A', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 30));
    expect(w.forbiddenStripeCalls).toEqual([]);
  });
});

describe('3. webhook idempotency + ordering', () => {
  it('duplicate delivery of the SAME event id is harmless: one write, one emit', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'trialing', price: PRICE.pro });
    const e = ev('checkout.session.completed', { id: 'cs_1', subscription: 'sub_A', customer: 'cus_1', customer_email: 'a@x.com', client_reference_id: U, metadata: { clerk_user_id: U } }, 10);
    await deliver(w, e);
    const writes = w.clerkWrites();
    await deliver(w, e);
    await deliver(w, e);
    expect(w.clerkWrites()).toBe(writes);
    expect(w.emits.filter(x => x.name === 'trial_started')).toHaveLength(1);
  });

  it('duplicate invoice.payment_succeeded does not double-emit paid_subscription_started', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 5));
    const inv = ev('invoice.payment_succeeded', { id: 'in_1', subscription: 'sub_A', amount_paid: 14900, customer_email: 'a@x.com' }, 10);
    await deliver(w, inv); await deliver(w, inv);
    expect(w.emits.filter(x => x.name === 'paid_subscription_started')).toHaveLength(1);
  });

  it('OUT OF ORDER: deleted (t=20) processed BEFORE updated-active (t=10) → stays revoked, even if Stripe retrieve is lagging', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 5));
    const staleActive = ev('customer.subscription.updated', subObj('sub_A', { status: 'active', price: PRICE.pro }), 10);
    w.setSub('sub_A', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 20));
    w.lagRetrieve('sub_A', { status: 'active' }); // Stripe read returns the OLD state (worst case)
    await deliver(w, staleActive);
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'cancelled', billing: 'cancelled' });
  });

  it('OUT OF ORDER with NO prior binding: deleted first, then created → not resurrected', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'canceled', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 20));
    w.lagRetrieve('sub_A', { status: 'active' });
    await deliver(w, ev('customer.subscription.created', subObj('sub_A', { status: 'active', price: PRICE.pro }), 10));
    expect(clerkEntitlement(w, U).tier).not.toBe('pro');
  });

  it('Stripe retrieve outage on a grant path throws (→ HTTP 500 → Stripe retries) instead of trusting a stale snapshot', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    w.failRetrieve = true;
    const r = await handleWebhook({
      stripe: { ...w.stripe, webhooks: { constructEvent: () => ev('customer.subscription.updated', subObj('sub_A', { status: 'active', price: PRICE.pro }), 10) } } as any,
      clerk: w.clerk as any, body: '{}', sig: 's', secret: 'x', emit: w.emit, alert: w.alert,
    });
    expect(r.status).toBe(500);
    expect(w.clerkWrites()).toBe(0);
  });

  it('a late OLD event for a superseded subscription cannot overwrite the new subscription', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.starter });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 20));
    w.setSub('sub_C', { status: 'active', price: PRICE.pro, customer: 'cus_3' });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_C'), 30));
    w.lagRetrieve('sub_A', { status: 'active' });
    await deliver(w, ev('customer.subscription.updated', subObj('sub_A', { status: 'active', price: PRICE.starter }), 15));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', subId: 'sub_C', billing: 'active' });
  });
});

describe('4. payment failures', () => {
  it('invoice.payment_failed on a renewal → billing_status=past_due (not active), owner alert raised', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { status: 'past_due' });
    await deliver(w, ev('invoice.payment_failed', { id: 'in_9', subscription: 'sub_A', customer: 'cus_1', attempt_count: 1 }, 20));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'past_due' });
    expect(w.alerts.map(a => a.kind)).toContain('payment_failed');
  });

  it('retries exhausted → unpaid → access revoked; paying again (payment_succeeded) restores it', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { status: 'past_due' });
    await deliver(w, ev('invoice.payment_failed', { id: 'in_9', subscription: 'sub_A', customer: 'cus_1' }, 20));
    w.setSub('sub_A', { status: 'unpaid' });
    await deliver(w, ev('customer.subscription.updated', w.sub('sub_A'), 30));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'cancelled', billing: 'unpaid' });
    w.setSub('sub_A', { status: 'active' });
    await deliver(w, ev('invoice.payment_succeeded', { id: 'in_10', subscription: 'sub_A', amount_paid: 14900, customer_email: 'a@x.com' }, 40));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active' });
    expect(core(clerkEntitlement(w, U))).toEqual(truthEntitlement(w, U));
  });

  it('newer Stripe API shape (invoice.parent.subscription_details.subscription) is understood', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('invoice.payment_succeeded', { id: 'in_1', amount_paid: 14900, customer_email: 'a@x.com', parent: { subscription_details: { subscription: 'sub_A' } } }, 10));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active' });
  });

  it('invoice.payment_failed never grants: failed payment on a never-entitled incomplete subscription writes nothing', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'incomplete', price: PRICE.pro });
    await deliver(w, ev('invoice.payment_failed', { id: 'in_1', subscription: 'sub_A', customer: 'cus_1' }, 10));
    expect(w.clerkWrites()).toBe(0);
  });
});

describe('5. unknown prices fail closed', () => {
  const UNKNOWN = 'price_UNKNOWN_123';
  it('new customer on an unknown price: NOT provisioned (never Starter), alert raised', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: UNKNOWN });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    expect(w.clerkWrites()).toBe(0);
    expect(clerkEntitlement(w, U).tier).toBeUndefined();
    expect(w.alerts.map(a => a.kind)).toContain('unknown_price');
  });
  it('checkout.session.completed on an unknown price: not provisioned, no trial_started', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'trialing', price: UNKNOWN });
    await deliver(w, ev('checkout.session.completed', { id: 'cs_1', subscription: 'sub_A', customer: 'cus_1', customer_email: 'a@x.com', client_reference_id: U, metadata: { clerk_user_id: U } }, 10));
    expect(w.clerkWrites()).toBe(0);
    expect(w.emits).toHaveLength(0);
  });
  it('invoice.payment_succeeded on an unknown price: not provisioned', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: UNKNOWN });
    await deliver(w, ev('invoice.payment_succeeded', { id: 'in_1', subscription: 'sub_A', amount_paid: 100, customer_email: 'a@x.com' }, 10));
    expect(w.clerkWrites()).toBe(0);
  });
  it('an existing paying customer whose subscription flips to an unknown price is left unchanged (alerted, not silently re-tiered)', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.team });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { price: UNKNOWN });
    await deliver(w, ev('customer.subscription.updated', w.sub('sub_A'), 20));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'team', billing: 'active' });
    expect(w.alerts.map(a => a.kind)).toContain('unknown_price');
  });
  it('trial_will_end on an unknown price does not pause or emit', async () => {
    const w = makeWorld();
    const s = subObj('sub_A', { status: 'trialing', price: UNKNOWN });
    await deliver(w, ev('customer.subscription.trial_will_end', s, 10));
    expect(w.stripeUpdates.filter(u => u.params?.pause_collection)).toHaveLength(0);
    expect(w.emits).toHaveLength(0);
  });
  it('a cancellation on an unknown price still revokes (revocation does not need a known tier)', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { status: 'canceled', price: UNKNOWN });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 20));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'cancelled' });
  });
  it('multi-item subscription: the highest KNOWN tier wins; unknown items are ignored', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', items: [UNKNOWN, PRICE.starter, PRICE.pro] });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    expect(clerkEntitlement(w, U).tier).toBe('pro');
  });
});

describe('dangerous lifecycle sequences end in Stripe truth', () => {
  it('trial → paid → canceled', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'trialing', price: PRICE.pro });
    await deliver(w, ev('checkout.session.completed', { id: 'cs_1', subscription: 'sub_A', customer: 'cus_1', customer_email: 'a@x.com', client_reference_id: U, metadata: { clerk_user_id: U } }, 10));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active' });
    w.setSub('sub_A', { status: 'active' });
    await deliver(w, ev('invoice.payment_succeeded', { id: 'in_1', subscription: 'sub_A', amount_paid: 14900, customer_email: 'a@x.com' }, 20));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active', rawStatus: 'active' });
    w.setSub('sub_A', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 30));
    expect(core(clerkEntitlement(w, U))).toEqual(truthEntitlement(w, U));
    expect(clerkEntitlement(w, U).tier).toBe('cancelled');
  });

  it('cancellation → reactivation (resubscribe on a NEW subscription)', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.starter });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { status: 'canceled' });
    await deliver(w, ev('customer.subscription.deleted', w.sub('sub_A'), 20));
    expect(clerkEntitlement(w, U).tier).toBe('cancelled');
    w.setSub('sub_B', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_B'), 30));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active', subId: 'sub_B' });
    expect(core(clerkEntitlement(w, U))).toEqual(truthEntitlement(w, U));
  });

  it('cancel_at_period_end set then unset keeps access throughout', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { cancel_at_period_end: true });
    await deliver(w, ev('customer.subscription.updated', w.sub('sub_A'), 20));
    w.setSub('sub_A', { cancel_at_period_end: false });
    await deliver(w, ev('customer.subscription.updated', w.sub('sub_A'), 30));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', billing: 'active' });
  });

  it('upgrade starter→pro on the same subscription re-tiers (existing behavior preserved)', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.starter });
    await deliver(w, ev('customer.subscription.created', w.sub('sub_A'), 10));
    w.setSub('sub_A', { price: PRICE.pro });
    await deliver(w, ev('customer.subscription.updated', w.sub('sub_A'), 20));
    expect(clerkEntitlement(w, U)).toMatchObject({ tier: 'pro', subId: 'sub_A' });
  });
});

describe('safety invariants', () => {
  it('no scenario ever creates/cancels/deletes a Stripe object or charges (only metadata mapping + the pause interlock)', async () => {
    const w = makeWorld();
    w.setSub('sub_A', { status: 'active', price: PRICE.pro });
    for (const [i, t] of ['customer.subscription.created', 'customer.subscription.updated', 'invoice.payment_failed', 'customer.subscription.deleted'].entries()) {
      const obj = t.startsWith('invoice') ? { id: 'in_' + i, subscription: 'sub_A', customer: 'cus_1' } : w.sub('sub_A');
      await deliver(w, ev(t, obj, 10 + i));
    }
    expect(w.forbiddenStripeCalls).toEqual([]);
  });
});

// ── Seeded fuzz: random status timelines, delivered shuffled and duplicated ─────────────────────
function rng(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; }
const STATUSES = ['trialing', 'active', 'past_due', 'unpaid', 'active', 'canceled'];

describe('fuzz: shuffled + duplicated delivery converges to Stripe truth', () => {
  it('300 seeded timelines, Stripe readable: final Clerk entitlement == truth', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const w = makeWorld();
      const n = 2 + Math.floor(r() * 5);
      const steps: any[] = [];
      let status = 'trialing';
      w.setSub('sub_A', { status, price: PRICE.pro });
      steps.push(ev('customer.subscription.created', w.sub('sub_A'), 10));
      for (let i = 1; i < n; i++) {
        status = STATUSES[Math.floor(r() * STATUSES.length)];
        w.setSub('sub_A', { status });
        steps.push(ev('customer.subscription.updated', w.sub('sub_A'), 10 + i * 10));
      }
      const delivery = [...steps, ...steps.filter(() => r() < 0.5)].sort(() => r() - 0.5);
      for (const e of delivery) await deliver(w, e);
      expect(core(clerkEntitlement(w, U)), `seed ${seed} final=${status}`).toEqual(truthEntitlement(w, U));
    }
  });

  it('300 seeded timelines, Stripe read returns STALE state (watermark-only): final == state of the newest event', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 7919);
      const w = makeWorld();
      w.setSub('sub_A', { status: 'active', price: PRICE.pro }); // exists in Stripe; reads below are deliberately stale
      const n = 2 + Math.floor(r() * 5);
      const steps: { e: any; status: string }[] = [];
      for (let i = 0; i < n; i++) {
        const status = i === 0 ? 'active' : STATUSES[Math.floor(r() * STATUSES.length)];
        steps.push({ status, e: ev(i === 0 ? 'customer.subscription.created' : 'customer.subscription.updated', subObj('sub_A', { status, price: PRICE.pro }), 10 + i * 10) });
      }
      const newest = steps[steps.length - 1].status;
      const delivery = [...steps, ...steps.filter(() => r() < 0.5)].sort(() => r() - 0.5);
      for (const s of delivery) { w.lagRetrieve('sub_A', { status: s.e.data.object.status }); await deliver(w, s.e); }
      const grants = ['trialing', 'active', 'past_due'].includes(newest);
      const c = clerkEntitlement(w, U);
      expect(c.tier === 'pro', `seed ${seed} newest=${newest} tier=${c.tier}`).toBe(grants);
    }
  });
});
