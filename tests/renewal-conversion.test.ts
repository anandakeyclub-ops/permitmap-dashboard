import { describe, it, expect } from 'vitest';
import { handleStripeEvent } from '../lib/provisioning';
import { wrapStripeWithIdempotentMapping } from '../lib/webhook-clients';
import { makeWorld, ev, PRICE } from './_entitlement-harness';

const deliver = (w: any, e: any) => handleStripeEvent(w.stripe, w.clerk, e, { emit: w.emit, alert: w.alert });
const conv = (w: any) => w.emits.filter((x: any) => x.name === 'paid_subscription_started');
const inv = (id: string, created: number, amount = 14900, extra: any = {}) => ({ id, created, subscription: 'sub_A', amount_paid: amount, status: 'paid', customer_email: 'a@x.com', ...extra });
const setup = () => { const w = makeWorld(); w.setSub('sub_A', { status: 'active', price: PRICE.pro }); return w; };

describe('paid_subscription_started = acquisition only (first successful paid invoice per subscription)', () => {
  it('first paid invoice emits exactly one conversion', async () => {
    const w = setup(); w.paidInvoices = [inv('in_1', 100)];
    await deliver(w, ev('invoice.payment_succeeded', inv('in_1', 100), 10));
    expect(conv(w)).toHaveLength(1); expect(conv(w)[0].props.properties).toMatchObject({ invoice_id: 'in_1', conversion_basis: 'first_paid_invoice' });
  });
  it('renewals (2nd, 3rd paid invoice) never emit a conversion — but still reconcile entitlement', async () => {
    const w = setup(); w.paidInvoices = [inv('in_1', 100), inv('in_2', 200), inv('in_3', 300)];
    await deliver(w, ev('invoice.payment_succeeded', inv('in_2', 200), 20)); await deliver(w, ev('invoice.payment_succeeded', inv('in_3', 300), 30));
    expect(conv(w)).toHaveLength(0); expect(w.users.get('user_1')!.publicMetadata).toMatchObject({ tier: 'pro', billing_status: 'active' });
  });
  it('TRIAL: the $0 trial-start invoice is not a conversion; the first PAID invoice at trial end is', async () => {
    const w = setup(); w.paidInvoices = [inv('in_trial', 50, 0, { billing_reason: 'subscription_create' }), inv('in_first', 100, 14900, { billing_reason: 'subscription_cycle' })];
    await deliver(w, ev('invoice.payment_succeeded', inv('in_trial', 50, 0), 5)); expect(conv(w)).toHaveLength(0);
    await deliver(w, ev('invoice.payment_succeeded', inv('in_first', 100, 14900, { billing_reason: 'subscription_cycle' }), 10)); expect(conv(w)).toHaveLength(1);
  });
  it('late redelivery of the FIRST invoice after renewals exist still classifies it as the acquisition (stateless, order-independent)', async () => {
    const w = setup(); w.paidInvoices = [inv('in_1', 100), inv('in_2', 200)];
    await deliver(w, ev('invoice.payment_succeeded', inv('in_2', 200), 20)); expect(conv(w)).toHaveLength(0);
    await deliver(w, ev('invoice.paid', inv('in_1', 100), 21)); expect(conv(w)).toHaveLength(1);
  });
  it('a lagging invoice list that omits the event invoice still counts the event invoice', async () => {
    const w = setup(); w.paidInvoices = [];
    await deliver(w, ev('invoice.paid', inv('in_1', 100), 10)); expect(conv(w)).toHaveLength(1);
  });
  it('a different subscription’s invoices are not counted', async () => {
    const w = setup(); w.paidInvoices = [{ ...inv('in_other', 10), subscription: 'sub_OTHER' }, inv('in_1', 100)];
    await deliver(w, ev('invoice.paid', inv('in_1', 100), 10)); expect(conv(w)).toHaveLength(1);
  });
  it('a resubscribe is a NEW subscription → its own first paid invoice is a conversion', async () => {
    const w = setup(); w.setSub('sub_B', { status: 'active', price: PRICE.pro, metadata: { clerk_user_id: 'user_1' } });
    w.paidInvoices = [inv('in_1', 100), { ...inv('in_b1', 900), subscription: 'sub_B' }];
    await deliver(w, ev('invoice.paid', { ...inv('in_b1', 900), subscription: 'sub_B' }, 90)); expect(conv(w)).toHaveLength(1);
  });
  it('invoice history cannot be read → NO conversion is guessed, an alert is raised, entitlement still reconciles', async () => {
    const w = setup(); w.failInvoiceList = true;
    await deliver(w, ev('invoice.paid', inv('in_1', 100), 10));
    expect(conv(w)).toHaveLength(0); expect(w.alerts.map((a: any) => a.kind)).toContain('conversion_classification_unavailable');
    expect(w.users.get('user_1')!.publicMetadata).toMatchObject({ tier: 'pro', billing_status: 'active' });
  });
  it('invoices API absent → same fail-safe (no emit, alert, entitlement unaffected)', async () => {
    const w = setup(); w.noInvoiceApi = true;
    await deliver(w, ev('invoice.paid', inv('in_1', 100), 10));
    expect(conv(w)).toHaveLength(0); expect(w.alerts.map((a: any) => a.kind)).toContain('conversion_classification_unavailable'); expect(w.users.get('user_1')!.publicMetadata.tier).toBe('pro');
  });
  it('Dahlia-shaped first invoice (parent.subscription_details) is classified correctly', async () => {
    const w = setup(); const d = { id: 'in_1', created: 100, amount_paid: 14900, customer_email: 'a@x.com', parent: { subscription_details: { subscription: 'sub_A' } } };
    w.paidInvoices = [{ ...d, subscription: 'sub_A' }]; await deliver(w, ev('invoice.paid', d, 10)); expect(conv(w)).toHaveLength(1);
  });
  it('invoice.payment_failed and zero-amount invoices never emit conversions', async () => {
    const w = setup(); await deliver(w, ev('invoice.payment_failed', { id: 'in_f', subscription: 'sub_A', customer: 'cus_1' }, 10));
    await deliver(w, ev('invoice.paid', inv('in_0', 100, 0), 11)); expect(conv(w)).toHaveLength(0);
  });
  it('KNOWN LIMITATION (documented): invoice.payment_succeeded AND invoice.paid for the SAME first invoice both classify as acquisition (distinct event ids); downstream dedupes on invoice_id', async () => {
    const w = setup(); w.paidInvoices = [inv('in_1', 100)];
    await deliver(w, ev('invoice.payment_succeeded', inv('in_1', 100), 10)); await deliver(w, ev('invoice.paid', inv('in_1', 100), 11));
    expect(new Set(conv(w).map((c: any) => c.props.properties.invoice_id)).size).toBe(1);
  });

  it('PRODUCTION WIRING: the webhook Stripe wrapper passes invoices.list through (read-only) — otherwise every conversion would silently go unreported', async () => {
    const w = setup(); w.paidInvoices = [inv('in_1', 100)];
    const wrapped: any = wrapStripeWithIdempotentMapping(w.stripe);
    expect(typeof wrapped.invoices?.list).toBe('function'); expect(Object.keys(wrapped.invoices)).toEqual(['list']);
    await handleStripeEvent(wrapped, w.clerk as any, ev('invoice.paid', inv('in_1', 100), 10), { emit: w.emit, alert: w.alert });
    expect(conv(w)).toHaveLength(1); expect(w.alerts.map((a: any) => a.kind)).not.toContain('conversion_classification_unavailable');
  });
});
