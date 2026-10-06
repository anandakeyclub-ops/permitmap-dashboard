import { describe, it, expect } from 'vitest';
import { checkEventContract, expectedSubscriptionId, summarize } from '../scripts/forensics/webhook-payload-contract-core';
import { makeWorld, PRICE } from './_entitlement-harness';

const users = () => new Map<string, Record<string, any>>([['user_1', {}]]);
const run = (w: any, ev: any) => checkEventContract(ev, { stripeRead: w.stripe, clerkUsers: users() });
const E = (type: string, object: any, api = '2026-03-25.dahlia', id = `evt_${Math.random()}`) => ({ id, type, api_version: api, created: 1, data: { object } });
const world = () => { const w = makeWorld(); w.setSub('sub_A', { status: 'active', price: PRICE.pro }); return w; };

// Shapes per Stripe's changelog: basil+ moved invoice.subscription to invoice.parent.subscription_details.subscription (and line-level parent);
// subscription current_period_* moved onto items. dahlia adds no further field removal on these objects.
const dahliaSubscription = () => { const s = JSON.parse(JSON.stringify(world().sub('sub_A'))); s.items.data.forEach((i: any) => { i.current_period_start = 1; i.current_period_end = 2; }); return s; };
const dahliaInvoice = (extra: any = {}) => ({ id: 'in_1', customer: 'cus_1', customer_email: 'a@x.com', amount_paid: 14900, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_A', metadata: {} } }, lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_A' } } }] }, ...extra });

describe('webhook payload contract (new API version shapes)', () => {
  it('finds the subscription id in every known invoice shape', () => {
    expect(expectedSubscriptionId(E('invoice.paid', { subscription: 'sub_A' }))).toBe('sub_A');
    expect(expectedSubscriptionId(E('invoice.paid', dahliaInvoice()))).toBe('sub_A');
    expect(expectedSubscriptionId(E('invoice.paid', { lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_A' } } }] } }))).toBe('sub_A');
  });
  it.each(['invoice.payment_succeeded', 'invoice.paid', 'invoice.payment_failed'])('%s in dahlia shape (no top-level subscription) is acted on', async (t) => {
    const r = await run(world(), E(t, dahliaInvoice())); expect(r.verdict).toBe('PASS'); expect(r.retrieved_subs).toContain('sub_A');
  });
  it('legacy-shape invoice still passes (rollback safety)', async () => {
    expect((await run(world(), E('invoice.paid', { id: 'in_1', subscription: 'sub_A', amount_paid: 14900, customer: 'cus_1' }, '2023-10-16'))).verdict).toBe('PASS');
  });
  it('subscription created/updated/deleted with items-level periods and no subscription-level current_period_* pass', async () => {
    for (const t of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
      const s = dahliaSubscription(); delete s.current_period_end; delete s.current_period_start;
      expect((await run(world(), E(t, t.endsWith('deleted') ? { ...s, status: 'canceled' } : s))).verdict).toBe('PASS');
    }
  });
  it('checkout.session.completed passes in new shape (subscription present once payment completes)', async () => {
    const r = await run(world(), E('checkout.session.completed', { id: 'cs_1', customer: 'cus_1', subscription: 'sub_A', customer_details: { email: 'a@x.com' }, client_reference_id: 'user_1', metadata: { clerk_user_id: 'user_1' } }));
    expect(r.verdict).toBe('PASS'); expect(r.retrieved_subs).toContain('sub_A');
  });
  it('DETECTS a silent drop: an invoice whose subscription reference sits somewhere the handler does not read', async () => {
    const ev = E('invoice.paid', { id: 'in_1', amount_paid: 14900, customer: 'cus_1', lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_A' } } }] } });
    const r = await run(world(), ev); expect(r.verdict).toBe('FAIL_SILENTLY_IGNORED');
  });
  it('flags unknown price and never writes Stripe', async () => {
    const w = makeWorld(); w.setSub('sub_A', { status: 'active', price: 'price_UNKNOWN' });
    const r = await run(w, E('customer.subscription.updated', w.sub('sub_A'))); expect(r.verdict).toBe('FAIL_UNEXPECTED_ALERT'); expect(r.would_write_stripe).toEqual([]);
  });
  it('zero-amount and non-subscription invoices are NOT_APPLICABLE, unrelated types too', async () => {
    expect((await run(world(), E('invoice.paid', dahliaInvoice({ amount_paid: 0 })))).verdict).toBe('NOT_APPLICABLE');
    expect((await run(world(), E('invoice.paid', { id: 'in_x', amount_paid: 500 }))).verdict).toBe('NOT_APPLICABLE');
    expect((await run(world(), E('customer.created', {}))).verdict).toBe('NOT_APPLICABLE');
  });
  it('summarize groups by API version and only certifies with zero failures and at least one PASS', () => {
    const s = summarize([{ verdict: 'PASS', api_version: '2026-03-25.dahlia' } as any, { verdict: 'FAIL_ERROR', api_version: '2023-10-16' } as any]);
    expect(s.certified).toBe(false); expect(s.by_api_version['2026-03-25.dahlia']).toEqual({ PASS: 1 });
  });
});
