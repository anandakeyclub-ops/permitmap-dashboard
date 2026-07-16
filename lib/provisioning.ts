// Pure, dependency-injected provisioning logic for the Stripe webhook (testable without Next).
// The route wrapper injects the real Stripe + Clerk clients and the emit/alert callbacks.

export const PRICE_TO_TIER: Record<string, string> = {
  'price_1TMtSHIgaDPbFgUVPElPgL8V': 'starter',
  'price_1TMtStIgaDPbFgUVPFOUjBMW': 'pro',
  'price_1TMtThIgaDPbFgUVoxIWlvf3': 'team',
};
export const TIER_COUNTIES: Record<string, number> = { starter: 1, pro: 5, team: 99 };

// client_reference_id may be a raw Clerk id (server-side checkout) or the legacy token
// v1_dashboard_upgrade_{userId}_{county}_{plan}_{yyyymmdd}. metadata.clerk_user_id preferred.
export function resolveClerkUserId(
  metadata?: Record<string, any> | null,
  clientRef?: string | null,
): string | null {
  const fromMeta = metadata?.clerk_user_id;
  if (fromMeta) return fromMeta;
  if (!clientRef) return null;
  if (clientRef.startsWith('user_')) return clientRef;
  if (clientRef.startsWith('v1_dashboard_upgrade_')) {
    const seg = clientRef.split('_'); // v1 dashboard upgrade {userId} ...
    return seg[3] || null;
  }
  return null;
}

export interface ClerkLike {
  users: {
    getUserList: (p: { emailAddress: string[] }) => Promise<{ totalCount: number; data: { id: string }[] }>;
    updateUserMetadata: (id: string, p: { publicMetadata: Record<string, any> }) => Promise<any>;
    createUser: (p: { emailAddress: string[]; publicMetadata: Record<string, any>; skipPasswordRequirement?: boolean }) => Promise<{ id: string }>;
  };
}
export interface StripeLike {
  subscriptions: { retrieve: (id: string) => Promise<any>; update: (id: string, p: any) => Promise<any> };
  customers: { retrieve: (id: string) => Promise<any>; update: (id: string, p: any) => Promise<any> };
  webhooks: { constructEvent: (body: string, sig: string, secret: string) => any };
}
type Alert = (kind: string, detail: Record<string, any>) => void;
type Emit = (name: string, props: Record<string, any>) => Promise<void>;

async function persistMapping(stripe: StripeLike, customerId: string, subId: string, clerkUserId: string) {
  try { await stripe.customers.update(customerId, { metadata: { clerk_user_id: clerkUserId } }); } catch (e) { /* best-effort */ }
  try { await stripe.subscriptions.update(subId, { metadata: { clerk_user_id: clerkUserId } }); } catch (e) { /* best-effort */ }
}

// Idempotent. Prefer linking by Clerk user id (durable); fall back to email (create if
// absent) and ALERT that identity was missing at checkout.
export async function provision(
  stripe: StripeLike, clerk: ClerkLike, alert: Alert,
  args: { email: string | null; tier: string; customerId: string; subId: string; clerkUserId: string | null },
): Promise<void> {
  const metadata = {
    tier: args.tier, stripe_customer_id: args.customerId, stripe_subscription_id: args.subId,
    counties_allowed: TIER_COUNTIES[args.tier] || 1, billing_status: 'active',
  };
  if (args.clerkUserId) {
    await clerk.users.updateUserMetadata(args.clerkUserId, { publicMetadata: metadata });
    await persistMapping(stripe, args.customerId, args.subId, args.clerkUserId);
    return;
  }
  alert('identity_missing_at_checkout', { email: args.email, customerId: args.customerId, subId: args.subId, tier: args.tier });
  if (!args.email) {
    // Truly unprovisionable (no Clerk id AND no email) → alert + throw so the webhook
    // returns non-2xx (Stripe retries; a later event may carry the email).
    alert('no_email_no_identity', { customerId: args.customerId, subId: args.subId });
    throw new Error('unprovisionable: no clerk_user_id and no email');
  }
  const existing = await clerk.users.getUserList({ emailAddress: [args.email] });
  if (existing.totalCount > 0) {
    await clerk.users.updateUserMetadata(existing.data[0].id, { publicMetadata: metadata });
    await persistMapping(stripe, args.customerId, args.subId, existing.data[0].id);
  } else {
    const created = await clerk.users.createUser({ emailAddress: [args.email], publicMetadata: metadata, skipPasswordRequirement: true });
    await persistMapping(stripe, args.customerId, args.subId, created.id);
  }
}

async function emailFromCustomer(stripe: StripeLike, customerId: string): Promise<string | null> {
  try {
    const c = await stripe.customers.retrieve(customerId);
    if (c?.deleted) return null;
    return c?.email ?? null;
  } catch { return null; }
}

// Route the parsed Stripe event to provisioning. Returns nothing; throws on transient
// errors (caller maps to 500 → Stripe retry). Never silent: alerts on missing identity.
export async function handleStripeEvent(
  stripe: StripeLike, clerk: ClerkLike, event: any, cb: { emit: Emit; alert: Alert },
): Promise<void> {
  const { emit, alert } = cb;
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const email = s.customer_email || s.customer_details?.email || null;
    const subId = s.subscription as string; const custId = s.customer as string;
    if (subId && custId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      const tier = PRICE_TO_TIER[sub.items.data[0]?.price?.id || ''] || 'starter';
      const clerkUserId = resolveClerkUserId(s.metadata, s.client_reference_id) || resolveClerkUserId(sub.metadata, null);
      await provision(stripe, clerk, alert, { email, tier, customerId: custId, subId, clerkUserId });
      await emit('trial_started', { client_reference_id: s.client_reference_id || undefined, stripe_session_id: s.id, stripe_subscription_id: subId, email: email || undefined, plan: tier, properties: { customer_id: custId, subscription_status: sub.status, clerk_user_id: clerkUserId || undefined } });
    }
  } else if (event.type === 'invoice.payment_succeeded') {
    const inv = event.data.object;
    const subId = inv.subscription as string;
    if ((inv.amount_paid || 0) > 0 && subId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      const tier = PRICE_TO_TIER[sub.items.data[0]?.price?.id || ''] || 'starter';
      const custId = sub.customer as string;
      const clerkUserId = resolveClerkUserId(sub.metadata, null);
      const email = inv.customer_email || (await emailFromCustomer(stripe, custId));
      await provision(stripe, clerk, alert, { email, tier, customerId: custId, subId, clerkUserId });
      await emit('paid_subscription_started', { stripe_subscription_id: subId, email: email || undefined, plan: tier, properties: { invoice_id: inv.id, amount_paid: inv.amount_paid, clerk_user_id: clerkUserId || undefined } });
    }
  } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const tier = PRICE_TO_TIER[sub.items.data[0]?.price?.id || ''] || 'starter';
    const custId = sub.customer as string;
    const clerkUserId = resolveClerkUserId(sub.metadata, null);
    const email = await emailFromCustomer(stripe, custId);
    await provision(stripe, clerk, alert, { email, tier, customerId: custId, subId: sub.id, clerkUserId });
  } else if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const clerkUserId = resolveClerkUserId(sub.metadata, null);
    const meta = { tier: 'cancelled', billing_status: 'cancelled' };
    if (clerkUserId) await clerk.users.updateUserMetadata(clerkUserId, { publicMetadata: meta });
    else {
      const email = await emailFromCustomer(stripe, sub.customer as string);
      if (email) { const ex = await clerk.users.getUserList({ emailAddress: [email] }); if (ex.totalCount > 0) await clerk.users.updateUserMetadata(ex.data[0].id, { publicMetadata: meta }); }
    }
  }
}

// Verify signature + dispatch. Returns {status}: 400 bad signature, 500 processing error
// (Stripe retries; provisioning is idempotent), 200 handled. Never silent.
export async function handleWebhook(deps: {
  stripe: StripeLike; clerk: ClerkLike; body: string; sig: string; secret: string; emit: Emit; alert: Alert;
}): Promise<{ status: number; body: any }> {
  let event: any;
  try {
    event = deps.stripe.webhooks.constructEvent(deps.body, deps.sig, deps.secret);
  } catch (err: any) {
    deps.alert('signature_verification_failed', { message: err?.message });
    return { status: 400, body: { error: 'Invalid signature' } };
  }
  try {
    await handleStripeEvent(deps.stripe, deps.clerk, event, { emit: deps.emit, alert: deps.alert });
  } catch (err: any) {
    deps.alert('webhook_processing_error', { type: event?.type, id: event?.id, message: err?.message });
    return { status: 500, body: { error: err?.message } };
  }
  return { status: 200, body: { received: true } };
}
