// Fixture helpers for scripts/stripe-test-replay.ts (kept separate so they are unit-testable).
//
// Root cause these guard against: Stripe test tokens such as `pm_card_visa` are NOT the id of the
// PaymentMethod that ends up attached to a customer. `paymentMethods.attach(token, {customer})`
// returns a PaymentMethod with its OWN id; using the literal token as the default/subscription
// payment method fails with "The payment method must be attached to the customer."
export interface PmClient {
  paymentMethods: { attach: (pm: string, p: { customer: string }) => Promise<any>; retrieve: (id: string) => Promise<any> };
  customers: { update: (id: string, p: any) => Promise<any>; retrieve: (id: string) => Promise<any> };
}

// Attach a test token to the customer and (optionally) make the ATTACHED payment method the default.
// Returns the attached PaymentMethod id (never the token). Throws if it is not attached to `customerId`.
export async function attachCard(stripe: PmClient, customerId: string, token: string, makeDefault = true): Promise<string> {
  const pm = await stripe.paymentMethods.attach(token, { customer: customerId });
  if (!pm?.id) throw new Error(`fixture: attach(${token}) returned no payment method id`);
  if (pm.customer !== customerId) throw new Error(`fixture invariant violated: attached ${pm.id}.customer=${pm.customer} !== ${customerId}`);
  if (makeDefault) await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
  return pm.id;
}

// Must pass before any subscription is created: the customer's default payment method exists and
// payment_method.customer === customer.id.
export async function assertDefaultPaymentMethodAttached(stripe: PmClient, customerId: string): Promise<string> {
  const c = await stripe.customers.retrieve(customerId);
  const ref = c?.invoice_settings?.default_payment_method;
  const id = typeof ref === 'string' ? ref : ref?.id;
  if (!id) throw new Error(`fixture invariant violated: customer ${customerId} has no default payment method`);
  const pm = await stripe.paymentMethods.retrieve(id);
  if (pm?.customer !== customerId) throw new Error(`fixture invariant violated: payment_method.customer (${pm?.customer}) !== customer.id (${customerId}) for ${id}`);
  return id;
}
