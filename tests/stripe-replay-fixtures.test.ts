// Regression test for the replay runner's payment-method fixture. The fake mimics the real Stripe
// behaviour that broke the first run: a test token (pm_card_visa) is NOT the id of the PaymentMethod
// that gets attached; attach() returns a new PaymentMethod with its own id.
import { describe, it, expect } from 'vitest';
import { attachCard, assertDefaultPaymentMethodAttached } from '../scripts/stripe-replay-fixtures';

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
