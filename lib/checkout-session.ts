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
  // Optional authoritative duplicate check. When present AND a customer id is known, we ask
  // Stripe directly whether the user already has a live subscription (catches the case where
  // the Clerk billing metadata is stale/missing). Absent in unit mocks → we fall back to the
  // Clerk-metadata signal only. Injected by the route with the real Stripe client.
  subscriptions?: {
    // `status` is loosely typed so the real Stripe client (whose param is a narrow Status union)
    // remains assignable to this interface under strictFunctionTypes contravariance.
    list: (params: { customer: string; status?: any; limit?: number }) => Promise<{ data: Array<{ status: string }> }>;
  };
}

// A subscription in any of these Stripe states means the user already has (or is mid-billing) a
// plan — starting a second checkout would create a duplicate paid subscription.
const LIVE_SUB_STATES = new Set(['trialing', 'active', 'past_due', 'unpaid']);

// Returns {status, body}. Never creates a session unless there is an authenticated user,
// a valid plan, and an email. A deterministic idempotency key (Clerk user + plan + intent
// nonce) makes duplicate submissions of the SAME intent reuse one Session, never duplicate.
//
// DUPLICATE-SUBSCRIPTION GUARD (highest financial risk): a signed-in user who already has an
// active plan must NOT be able to start a second checkout (the incident: two $149 Pro subs from
// two checkouts ~11 min apart). We block here — the primary guard — and return 409 so the client
// routes them to Manage Billing. The webhook is the backstop for races/direct-Stripe creations.
export async function handleCheckout(deps: {
  userId: string | null;
  email: string | null;
  plan: string | undefined;
  existingCustomer?: string;
  // Current entitlement snapshot from Clerk publicMetadata (read by the route). Cheap primary signal.
  existingSubscriptionId?: string;
  billingStatus?: string;
  appUrl: string;
  attribution?: IntentParams | null;
  stripe: StripeCheckoutLike;
}): Promise<{ status: number; body: any }> {
  if (!deps.userId) return { status: 401, body: { error: 'authentication required' } };
  if (!isPlan(deps.plan) || !PRICE_BY_PLAN[deps.plan]) return { status: 400, body: { error: `unknown plan: ${deps.plan}` } };
  if (!deps.email) return { status: 400, body: { error: 'no email on Clerk user' } };

  // ── duplicate-subscription guard ──
  // (1) cheap Clerk-metadata signal: an active plan already recorded on the user.
  const clerkSaysActive = deps.billingStatus === 'active' && !!deps.existingSubscriptionId;
  // (2) authoritative Stripe check when a customer id + list() are available (non-fatal on error).
  let stripeSaysActive = false;
  if (!clerkSaysActive && deps.existingCustomer && deps.stripe.subscriptions?.list) {
    try {
      const subs = await deps.stripe.subscriptions.list({ customer: deps.existingCustomer, status: 'all', limit: 100 });
      stripeSaysActive = (subs?.data || []).some((s) => LIVE_SUB_STATES.has(s.status));
    } catch { /* treat as inconclusive; fall back to the Clerk signal only */ }
  }
  if (clerkSaysActive || stripeSaysActive) {
    return {
      status: 409,
      body: {
        error: 'active_subscription_exists',
        code: 'active_subscription_exists',
        manage_billing: true,
        message: 'You already have an active PermitMap plan. Manage or change it from billing.',
      },
    };
  }

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
