// Pure, dependency-injected checkout logic (testable without Next request/response).
// The route wrapper resolves the Clerk user + email, then calls handleCheckout().

import { isPlan, pickMetadata, checkoutIdempotencyKey, type IntentParams } from './checkout-intent';

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
  // Allowlisted attribution carried from the marketing CTA through sign-up → resume.
  attribution?: IntentParams | null;
}

// Build the Stripe Checkout Session params with the Clerk identity bound three ways:
// client_reference_id, session.metadata.clerk_user_id, subscription_data.metadata.clerk_user_id.
// Allowlisted, PII-free attribution is stamped onto both the session and the subscription.
export function buildCheckoutParams(o: CheckoutOpts): Record<string, any> {
  const attrMeta = pickMetadata(o.attribution);
  const metadata = { clerk_user_id: o.userId, plan: o.plan, ...attrMeta };
  return {
    mode: 'subscription',
    line_items: [{ price: PRICE_BY_PLAN[o.plan], quantity: 1 }],
    client_reference_id: o.userId,
    ...(o.existingCustomer ? { customer: o.existingCustomer } : { customer_email: o.email }),
    metadata,
    subscription_data: {
      trial_period_days: 14,
      metadata,
    },
    success_url: `${o.appUrl}/dashboard?checkout=success`,
    cancel_url: `${o.appUrl}/pricing?checkout=cancelled`,
    allow_promotion_codes: true,
  };
}

export interface StripeCheckoutLike {
  checkout: {
    sessions: {
      create: (params: Record<string, any>, options?: { idempotencyKey?: string }) => Promise<{ url: string | null }>;
    };
  };
}

// Returns {status, body}. Never creates a session unless there is an authenticated user,
// a valid plan, and an email. A deterministic idempotency key (Clerk user + plan + intent
// nonce) makes duplicate submissions of the SAME intent reuse one Session, never duplicate.
export async function handleCheckout(deps: {
  userId: string | null;
  email: string | null;
  plan: string | undefined;
  existingCustomer?: string;
  appUrl: string;
  attribution?: IntentParams | null;
  stripe: StripeCheckoutLike;
}): Promise<{ status: number; body: any }> {
  if (!deps.userId) return { status: 401, body: { error: 'authentication required' } };
  if (!isPlan(deps.plan) || !PRICE_BY_PLAN[deps.plan]) return { status: 400, body: { error: `unknown plan: ${deps.plan}` } };
  if (!deps.email) return { status: 400, body: { error: 'no email on Clerk user' } };
  const idempotencyKey = checkoutIdempotencyKey(deps.userId, deps.plan, deps.attribution);
  const session = await deps.stripe.checkout.sessions.create(
    buildCheckoutParams({
      userId: deps.userId, email: deps.email, plan: deps.plan,
      existingCustomer: deps.existingCustomer, appUrl: deps.appUrl, attribution: deps.attribution,
    }),
    { idempotencyKey },
  );
  return { status: 200, body: { url: session.url } };
}
