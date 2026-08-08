// Pure, dependency-injected provisioning logic for the Stripe webhook (testable without Next).
// The route wrapper injects the real Stripe + Clerk clients and the emit/alert callbacks.

export const PRICE_TO_TIER: Record<string, string> = {
  'price_1TMtSHIgaDPbFgUVPElPgL8V': 'starter',
  'price_1TMtStIgaDPbFgUVPFOUjBMW': 'pro',
  'price_1TMtThIgaDPbFgUVoxIWlvf3': 'team',
};
export const TIER_COUNTIES: Record<string, number> = { starter: 1, pro: 5, team: 99 };

// Tiers that grant ALL counties — no per-county entitlement required (mirrors
// permitmap_api verify_admin.ALL_COUNTY_TIERS). County-limited tiers (starter/pro) need a
// non-empty allowed_counties list or the weekly digest is ineligible ("no county configured").
export const ALL_COUNTY_TIERS = new Set<string>(['team']);

// The county the customer selected at checkout, stamped onto the Checkout Session and
// subscription_data metadata by buildCheckoutParams (allowlisted, PII-free attribution).
// Normalized to the lowercase underscore slug the API/data pipeline uses
// (e.g. "Marion" → "marion", "St. Lucie" → "st_lucie").
export function resolveSelectedCounty(metadata?: Record<string, any> | null): string | null {
  const raw = metadata?.county;
  if (!raw || typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase().replace(/[.\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return slug || null;
}

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
    // Optional: read an existing user's publicMetadata so provisioning can detect a SECOND
    // active subscription and refuse to clobber the first binding. Absent in older mocks →
    // the guard is a no-op and behavior is unchanged (last-write-wins as before).
    getUser?: (id: string) => Promise<{ publicMetadata?: Record<string, any> } | null>;
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

// Read a user's existing publicMetadata (no-op if the Clerk client can't getUser).
async function readPublicMetadata(clerk: ClerkLike, userId: string): Promise<Record<string, any> | null> {
  if (!clerk.users.getUser) return null;
  try { const u = await clerk.users.getUser(userId); return (u?.publicMetadata as Record<string, any>) || null; }
  catch { return null; }
}

// True when the user already has an ACTIVE subscription that is DIFFERENT from the incoming one —
// i.e. a genuine duplicate. Same sub id (trial→paid, plan change, event re-delivery) is NOT a
// duplicate. A cancelled prior sub (billing_status='cancelled') is NOT a duplicate (they resubscribed).
function isForeignActiveSubscription(pm: Record<string, any> | null, incomingSubId: string): boolean {
  return !!pm && pm.billing_status === 'active'
    && !!pm.stripe_subscription_id && pm.stripe_subscription_id !== incomingSubId;
}

// Write entitlement to a resolved Clerk user — UNLESS a different active subscription is already
// bound. In that case we protect the original binding, alert, and stamp the duplicate's Stripe
// objects with the clerk id for traceability (so the Revenue-Integrity sweep can reconcile it).
// No auto-cancel/refund — cancellation stays a human/sweep decision (per operator policy).
async function applyEntitlement(
  stripe: StripeLike, clerk: ClerkLike, alert: Alert, targetUserId: string,
  args: { customerId: string; subId: string; tier: string }, metadata: Record<string, any>,
): Promise<void> {
  const pm = await readPublicMetadata(clerk, targetUserId);
  if (isForeignActiveSubscription(pm, args.subId)) {
    alert('duplicate_subscription', {
      clerk_user_id: targetUserId, existing_subscription_id: pm!.stripe_subscription_id,
      new_subscription_id: args.subId, customer_id: args.customerId, tier: args.tier,
    });
    await persistMapping(stripe, args.customerId, args.subId, targetUserId); // traceability only
    return; // do NOT overwrite the original entitlement/binding
  }
  await clerk.users.updateUserMetadata(targetUserId, { publicMetadata: metadata });
  await persistMapping(stripe, args.customerId, args.subId, targetUserId);
}

// Idempotent. Prefer linking by Clerk user id (durable); fall back to email (create if
// absent) and ALERT that identity was missing at checkout.
export async function provision(
  stripe: StripeLike, clerk: ClerkLike, alert: Alert,
  args: { email: string | null; tier: string; customerId: string; subId: string; clerkUserId: string | null; county?: string | null },
): Promise<void> {
  const metadata: Record<string, any> = {
    tier: args.tier, stripe_customer_id: args.customerId, stripe_subscription_id: args.subId,
    counties_allowed: TIER_COUNTIES[args.tier] || 1, billing_status: 'active',
  };
  // County-limited tiers (starter/pro) must carry the SPECIFIC selected county as
  // allowed_counties, or the weekly digest is ineligible ("no county configured for
  // county-limited tier"). Team grants all counties, so this is skipped. Only set when a
  // county is known, so an event without county metadata never clobbers an existing list.
  if (!ALL_COUNTY_TIERS.has(args.tier) && args.county) {
    metadata.allowed_counties = [args.county];
  }
  if (args.clerkUserId) {
    await applyEntitlement(stripe, clerk, alert, args.clerkUserId, args, metadata);
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
    await applyEntitlement(stripe, clerk, alert, existing.data[0].id, args, metadata);
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
      const county = resolveSelectedCounty(s.metadata) || resolveSelectedCounty(sub.metadata);
      await provision(stripe, clerk, alert, { email, tier, customerId: custId, subId, clerkUserId, county });
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
      const county = resolveSelectedCounty(sub.metadata);
      await provision(stripe, clerk, alert, { email, tier, customerId: custId, subId, clerkUserId, county });
      await emit('paid_subscription_started', { stripe_subscription_id: subId, email: email || undefined, plan: tier, properties: { invoice_id: inv.id, amount_paid: inv.amount_paid, clerk_user_id: clerkUserId || undefined } });
    }
  } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const tier = PRICE_TO_TIER[sub.items.data[0]?.price?.id || ''] || 'starter';
    const custId = sub.customer as string;
    const clerkUserId = resolveClerkUserId(sub.metadata, null);
    const email = await emailFromCustomer(stripe, custId);
    const county = resolveSelectedCounty(sub.metadata);
    await provision(stripe, clerk, alert, { email, tier, customerId: custId, subId: sub.id, clerkUserId, county });
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
