// Pure, dependency-injected checkout logic (testable without Next request/response).
// The route wrapper resolves the Clerk user + email, then calls handleCheckout().

export const PRICE_BY_PLAN: Record<string, string> = {
  starter: 'price_1TMtSHIgaDPbFgUVPElPgL8V',
  pro: 'price_1TMtStIgaDPbFgUVPFOUjBMW',
  team: 'price_1TMtThIgaDPbFgUVoxIWlvf3',
};

export interface CheckoutOpts {
  userId: string;
  email: string;
  plan: string;
  existingCustomer?: string;
  appUrl: string;
}

// Build the Stripe Checkout Session params with the Clerk identity bound three ways:
// client_reference_id, session.metadata.clerk_user_id, subscription_data.metadata.clerk_user_id.
export function buildCheckoutParams(o: CheckoutOpts): Record<string, any> {
  return {
    mode: 'subscription',
    line_items: [{ price: PRICE_BY_PLAN[o.plan], quantity: 1 }],
    client_reference_id: o.userId,
    ...(o.existingCustomer ? { customer: o.existingCustomer } : { customer_email: o.email }),
    metadata: { clerk_user_id: o.userId, plan: o.plan },
    subscription_data: {
      trial_period_days: 14,
      metadata: { clerk_user_id: o.userId, plan: o.plan },
    },
    success_url: `${o.appUrl}/dashboard?checkout=success`,
    cancel_url: `${o.appUrl}/pricing?checkout=cancelled`,
    allow_promotion_codes: true,
  };
}

export interface StripeCheckoutLike {
  checkout: { sessions: { create: (params: Record<string, any>) => Promise<{ url: string | null }> } };
}

// Returns {status, body}. Never creates a session unless there is an authenticated user,
// a known plan, and an email.
export async function handleCheckout(deps: {
  userId: string | null;
  email: string | null;
  plan: string | undefined;
  existingCustomer?: string;
  appUrl: string;
  stripe: StripeCheckoutLike;
}): Promise<{ status: number; body: any }> {
  if (!deps.userId) return { status: 401, body: { error: 'authentication required' } };
  if (!deps.plan || !PRICE_BY_PLAN[deps.plan]) return { status: 400, body: { error: `unknown plan: ${deps.plan}` } };
  if (!deps.email) return { status: 400, body: { error: 'no email on Clerk user' } };
  const session = await deps.stripe.checkout.sessions.create(
    buildCheckoutParams({ userId: deps.userId, email: deps.email, plan: deps.plan, existingCustomer: deps.existingCustomer, appUrl: deps.appUrl }),
  );
  return { status: 200, body: { url: session.url } };
}
