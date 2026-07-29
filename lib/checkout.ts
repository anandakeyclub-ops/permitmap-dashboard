// Plan tiers.
//
// The anonymous buy.stripe.com Payment Links (TRIAL_LINKS) and the checkoutUrl()/
// buildClientReferenceId() helpers were REMOVED: all subscription checkout now goes
// through the authenticated server route POST /api/checkout (see lib/start-checkout.ts
// and app/api/checkout/route.ts). Do NOT reintroduce Payment Links for subscriptions —
// they allow anonymous payment with no Clerk identity, which orphaned a paying customer.
export type Plan = 'starter' | 'pro' | 'team';
