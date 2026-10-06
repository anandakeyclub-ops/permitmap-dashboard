// Pure, dependency-injected provisioning logic for the Stripe webhook (testable without Next).
// The route wrapper injects the real Stripe + Clerk clients and the emit/alert callbacks.

import { evaluateOnboarding, migrateLegacySelectedCounties } from './onboarding';
import { interlockDecision, PAUSE_PARAMS } from './lifecycle';

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

// ── Entitlement truth ────────────────────────────────────────────────────────────────────────
// Stripe is the source of truth. Entitlement is derived from the subscription's CURRENT status and
// price, never from "an event arrived". Unknown prices FAIL CLOSED (no silent fallback to Starter).
const TIER_RANK: Record<string, number> = { starter: 1, pro: 2, team: 3 };

// Highest known tier among the subscription's items; null when NO item has a known price.
export function tierForSubscription(sub: any): string | null {
  let best: string | null = null;
  for (const it of sub?.items?.data || []) {
    const t = PRICE_TO_TIER[it?.price?.id || ''];
    if (t && (!best || TIER_RANK[t] > TIER_RANK[best])) best = t;
  }
  return best;
}

export type EntitlementDecision =
  | { action: 'grant'; billingStatus: string }
  | { action: 'revoke'; billingStatus: string }
  | { action: 'noop'; reason: string };

// trialing → entitled (billing_status stays 'active' exactly as before; the raw Stripe status is
// recorded separately in stripe_subscription_status). past_due → entitled during Stripe's dunning
// window but NEVER stamped 'active'. Everything else that is not a paying/trialing state is revoked
// or ignored. Unknown statuses are ignored (fail closed: they never grant).
export function entitlementForStatus(status: string | undefined, paused: boolean): EntitlementDecision {
  switch (status) {
    case 'trialing':
    case 'active': return { action: 'grant', billingStatus: paused ? 'paused' : 'active' };
    case 'past_due': return { action: 'grant', billingStatus: 'past_due' };
    case 'unpaid': return { action: 'revoke', billingStatus: 'unpaid' };
    case 'canceled': return { action: 'revoke', billingStatus: 'cancelled' };
    case 'incomplete_expired': return { action: 'revoke', billingStatus: 'incomplete_expired' };
    case 'paused': return { action: 'revoke', billingStatus: 'paused' };
    case 'incomplete': return { action: 'noop', reason: 'incomplete_never_grants' };
    default: return { action: 'noop', reason: `unknown_status:${status ?? 'undefined'}` };
  }
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
  subscriptions: {
    retrieve: (id: string) => Promise<any>; update: (id: string, p: any) => Promise<any>;
    // Optional READ-ONLY lookups used to reconcile duplicate subscriptions. Absent in older mocks.
    list?: (p: any) => Promise<{ data: any[] }>;
    search?: (p: any) => Promise<{ data: any[] }>;
  };
  customers: { retrieve: (id: string) => Promise<any>; update: (id: string, p: any) => Promise<any> };
  // Optional READ-ONLY: paid-invoice history, used only to tell the acquisition conversion from renewals.
  invoices?: { list: (p: any) => Promise<{ data: any[]; has_more?: boolean }> };
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

// ── Event idempotency + ordering ─────────────────────────────────────────────────────────────
// State lives in Clerk publicMetadata (no other store). stripe_event_created is a per-binding
// watermark; stripe_event_ids is a small ring of recently applied event ids. Both are only compared
// against events for the SAME subscription that holds the binding.
const EVENT_ID_RING = 10;
export type Outcome = 'applied' | 'foreign_duplicate' | 'duplicate_event' | 'stale_event' | 'skipped' | 'revoked' | 'nonbound_ended' | 'promoted';
export interface EventCtx { eventId?: string | null; eventCreated?: number | null }

function replayGuard(pm: Record<string, any> | null, subId: string, ctx: EventCtx): Outcome | null {
  if (!pm) return null;
  if (ctx.eventId && Array.isArray(pm.stripe_event_ids) && pm.stripe_event_ids.includes(ctx.eventId)) return 'duplicate_event';
  const bound = pm.stripe_subscription_id === subId;
  if (bound && typeof pm.stripe_event_created === 'number' && typeof ctx.eventCreated === 'number'
      && ctx.eventCreated < pm.stripe_event_created) return 'stale_event';
  return null;
}

function eventMarkers(pm: Record<string, any> | null, ctx: EventCtx, sameBinding: boolean): Record<string, any> {
  const ids = Array.isArray(pm?.stripe_event_ids) ? [...pm!.stripe_event_ids] : [];
  if (ctx.eventId && !ids.includes(ctx.eventId)) ids.push(ctx.eventId);
  const prev = sameBinding && typeof pm?.stripe_event_created === 'number' ? pm!.stripe_event_created : 0;
  const out: Record<string, any> = { stripe_event_ids: ids.slice(-EVENT_ID_RING) };
  const created = typeof ctx.eventCreated === 'number' ? Math.max(prev, ctx.eventCreated) : (prev || undefined);
  if (created !== undefined) out.stripe_event_created = created;
  return out;
}

// Write entitlement to a resolved Clerk user — UNLESS a different active subscription is already
// bound. In that case we protect the original binding, alert, and stamp the duplicate's Stripe
// objects with the clerk id for traceability (so the Revenue-Integrity sweep can reconcile it).
// No auto-cancel/refund — cancellation stays a human/sweep decision (per operator policy).
async function applyEntitlement(
  stripe: StripeLike, clerk: ClerkLike, alert: Alert, targetUserId: string,
  args: { customerId: string; subId: string; tier: string; email?: string | null }, metadata: Record<string, any>,
  ctx: EventCtx = {}, opts: { allowRebind?: boolean } = {},
): Promise<Outcome> {
  const pm = await readPublicMetadata(clerk, targetUserId);
  const replay = replayGuard(pm, args.subId, ctx);
  if (replay) return replay;
  if (!opts.allowRebind && isForeignActiveSubscription(pm, args.subId)) {
    alert('duplicate_subscription', {
      clerk_user_id: targetUserId, existing_subscription_id: pm!.stripe_subscription_id,
      new_subscription_id: args.subId, customer_id: args.customerId, tier: args.tier,
    });
    await persistMapping(stripe, args.customerId, args.subId, targetUserId); // traceability only
    return 'foreign_duplicate'; // do NOT overwrite the original entitlement/binding
  }
  // P4: (re)compute onboarding_complete from EXISTING selections + this tier — never deleting
  // selections (upgrade may complete it; downgrade over-limit stays incomplete for review). A
  // brand-new paid signup with no selections is stamped onboarding_complete=false, so a Belman-
  // shaped customer is flagged at provision time, not silently treated as onboarded. Guarded on
  // getUser so injected test clients without it keep the prior payload unchanged.
  let payload: Record<string, any> = metadata;
  if (clerk.users.getUser) {
    // Prefer the county on THIS event's metadata; else the customer's existing selection (canonical
    // selected_counties, or a legacy allowed_counties LIST — never a numeric allowance).
    const selectedCounties = (metadata.selected_counties as string[]) || migrateLegacySelectedCounties(pm);
    const r = evaluateOnboarding({
      tier: args.tier, selected_counties: selectedCounties,
      selected_trades: (pm?.selected_trades as string[]) || [],
      email: args.email || 'clerk-user',   // a resolved Clerk user always has an email
    });
    payload = { ...metadata, onboarding_complete: r.complete, onboarding_state: r.state, onboarding_reasons: r.reasons };
  }
  if (pm) payload = { ...payload, ...eventMarkers(pm, ctx, pm.stripe_subscription_id === args.subId) };
  await clerk.users.updateUserMetadata(targetUserId, { publicMetadata: payload });
  await persistMapping(stripe, args.customerId, args.subId, targetUserId);
  return 'applied';
}

type ProvisionArgs = {
  email: string | null; tier: string; customerId: string; subId: string; clerkUserId: string | null;
  county?: string | null; paused?: boolean;
  // Derived from Stripe's CURRENT subscription status (see entitlementForStatus). Defaults keep the
  // pre-existing payload for callers that do not pass them.
  billingStatus?: string; stripeStatus?: string;
};

// Idempotent. Prefer linking by Clerk user id (durable); fall back to email (create if
// absent) and ALERT that identity was missing at checkout.
export async function provision(
  stripe: StripeLike, clerk: ClerkLike, alert: Alert, args: ProvisionArgs, ctx: EventCtx = {},
  opts: { allowRebind?: boolean } = {},
): Promise<Outcome> {
  const metadata: Record<string, any> = {
    tier: args.tier, stripe_customer_id: args.customerId, stripe_subscription_id: args.subId,
    // A subscription with pause_collection set (the Seam-3 interlock) becomes status=active at trial
    // end but is NOT billed ($0, invoices voided). Do NOT stamp it 'active' (permit_bot counts that
    // as active_paid MRR) — mark 'paused' so it is excluded from paying revenue and surfaces as a
    // distinct lifecycle exception. Reset to 'active' on resume (onboarding completion).
    counties_allowed: TIER_COUNTIES[args.tier] || 1,
    billing_status: args.billingStatus ?? (args.paused ? 'paused' : 'active'),
  };
  if (args.stripeStatus) metadata.stripe_subscription_status = args.stripeStatus;
  // County-limited tiers (starter/pro) carry the SPECIFIC selected county as the canonical
  // selected_counties (a checkout-metadata county IS a customer selection). Team grants all
  // counties, so skipped. Only set when a county is known, so an event without county metadata
  // never clobbers an existing selection. (New field; legacy allowed_counties is read, not written.)
  if (!ALL_COUNTY_TIERS.has(args.tier) && args.county) {
    metadata.selected_counties = [args.county];
  }
  if (args.clerkUserId) {
    return applyEntitlement(stripe, clerk, alert, args.clerkUserId, args, metadata, ctx, opts);
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
    return applyEntitlement(stripe, clerk, alert, existing.data[0].id, args, metadata, ctx, opts);
  }
  const created = await clerk.users.createUser({ emailAddress: [args.email], publicMetadata: { ...metadata, ...eventMarkers(null, ctx, false) }, skipPasswordRequirement: true });
  await persistMapping(stripe, args.customerId, args.subId, created.id);
  return 'applied';
}

async function emailFromCustomer(stripe: StripeLike, customerId: string): Promise<string | null> {
  try {
    const c = await stripe.customers.retrieve(customerId);
    if (c?.deleted) return null;
    return c?.email ?? null;
  } catch { return null; }
}

// ── Subscription reconciliation (single path for every subscription-shaped event) ────────────
// Re-reads the subscription from Stripe so a late/out-of-order event can never apply an OLD snapshot:
// the CURRENT status decides entitlement.
async function currentSubscription(stripe: StripeLike, eventSub: any): Promise<any> {
  // If Stripe cannot be read this THROWS (→ webhook 500 → Stripe retries) rather than acting on a
  // possibly-stale snapshot: an out-of-date 'active' snapshot must never grant access.
  const fresh = await stripe.subscriptions.retrieve(eventSub.id);
  if (fresh && fresh.id === eventSub.id && fresh.status) return { ...eventSub, ...fresh, metadata: { ...(eventSub.metadata || {}), ...(fresh.metadata || {}) } };
  return eventSub;
}

const SAFE_ID = /^[A-Za-z0-9_]+$/;

// READ-ONLY: other subscriptions that still grant entitlement to this user (never mutates Stripe).
async function otherEntitledSubscriptions(stripe: StripeLike, userId: string, customerId: string, excludeSubId: string): Promise<any[]> {
  const seen = new Map<string, any>();
  const add = (rows: any[] | undefined) => { for (const r of rows || []) if (r?.id && r.id !== excludeSubId) seen.set(r.id, r); };
  try { if (stripe.subscriptions.search && SAFE_ID.test(userId)) add((await stripe.subscriptions.search({ query: `metadata['clerk_user_id']:'${userId}'`, limit: 100 })).data); } catch { /* best-effort */ }
  try { if (stripe.subscriptions.list && customerId) add((await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })).data); } catch { /* best-effort */ }
  return [...seen.values()].filter(r => entitlementForStatus(r.status, !!r.pause_collection).action === 'grant' && tierForSubscription(r));
}

async function resolveRevocationTarget(stripe: StripeLike, clerk: ClerkLike, sub: any): Promise<string | null> {
  const direct = resolveClerkUserId(sub.metadata, null);
  if (direct) return direct;
  const email = await emailFromCustomer(stripe, sub.customer as string);
  if (!email) return null;
  const ex = await clerk.users.getUserList({ emailAddress: [email] });
  return ex.totalCount > 0 ? ex.data[0].id : null;
}

async function revokeEntitlement(
  stripe: StripeLike, clerk: ClerkLike, alert: Alert, sub: any, billingStatus: string, ctx: EventCtx,
): Promise<Outcome> {
  const userId = await resolveRevocationTarget(stripe, clerk, sub);
  if (!userId) return 'skipped';
  const pm = await readPublicMetadata(clerk, userId);
  const replay = replayGuard(pm, sub.id, ctx);
  if (replay) return replay;
  const boundId = pm?.stripe_subscription_id as string | undefined;
  if (boundId && boundId !== sub.id) {
    // A non-bound subscription (duplicate / superseded) ended. It never granted this user's access,
    // so ending it must not revoke the entitlement held by the bound subscription.
    alert('nonbound_subscription_ended', { clerk_user_id: userId, ended_subscription_id: sub.id, bound_subscription_id: boundId, status: sub.status });
    return 'nonbound_ended';
  }
  // The bound subscription ended. If ANOTHER valid subscription still grants entitlement (e.g. the
  // duplicate the guard refused to bind), promote it instead of revoking a paying customer.
  const alts = await otherEntitledSubscriptions(stripe, userId, sub.customer as string, sub.id);
  if (alts.length) {
    alts.sort((a, b) => (TIER_RANK[tierForSubscription(b)!] - TIER_RANK[tierForSubscription(a)!]) || ((b.created || 0) - (a.created || 0)));
    const alt = alts[0];
    const decision = entitlementForStatus(alt.status, !!alt.pause_collection) as { action: 'grant'; billingStatus: string };
    alert('duplicate_subscription_promoted', { clerk_user_id: userId, ended_subscription_id: sub.id, promoted_subscription_id: alt.id });
    await provision(stripe, clerk, alert, {
      email: null, tier: tierForSubscription(alt)!, customerId: alt.customer as string, subId: alt.id, clerkUserId: userId,
      county: resolveSelectedCounty(alt.metadata), paused: !!alt.pause_collection,
      billingStatus: decision.billingStatus, stripeStatus: alt.status,
    }, {}, { allowRebind: true });
    // Restamp markers for the ENDED sub's event so its replay is recognised.
    return 'promoted';
  }
  await clerk.users.updateUserMetadata(userId, {
    // Bind the ended subscription id so its watermark protects against a late older event (an
    // out-of-order `updated` must not resurrect access when `deleted` was processed first).
    publicMetadata: { tier: 'cancelled', billing_status: billingStatus, stripe_subscription_id: sub.id, stripe_subscription_status: sub.status, ...eventMarkers(pm, ctx, boundId === sub.id) },
  });
  return 'revoked';
}

export async function reconcileSubscription(
  stripe: StripeLike, clerk: ClerkLike, alert: Alert, eventSub: any,
  extra: { email?: string | null; clerkUserId?: string | null; county?: string | null; useEventSnapshot?: boolean } & EventCtx = {},
): Promise<{ outcome: Outcome; decision: EntitlementDecision; sub: any; tier: string | null }> {
  const sub = extra.useEventSnapshot ? eventSub : await currentSubscription(stripe, eventSub);
  const paused = !!sub.pause_collection;
  const decision = entitlementForStatus(sub.status, paused);
  const ctx: EventCtx = { eventId: extra.eventId, eventCreated: extra.eventCreated };
  const tier = tierForSubscription(sub);
  if (decision.action === 'revoke') {
    return { outcome: await revokeEntitlement(stripe, clerk, alert, sub, decision.billingStatus, ctx), decision, sub, tier };
  }
  if (decision.action === 'noop') {
    if (decision.reason.startsWith('unknown_status')) alert('unknown_subscription_status', { subscription_id: sub.id, status: sub.status });
    return { outcome: 'skipped', decision, sub, tier };
  }
  if (!tier) {
    // FAIL CLOSED: an unrecognised price never grants anything (and never defaults to Starter).
    alert('unknown_price', { subscription_id: sub.id, customer_id: sub.customer, price_ids: (sub.items?.data || []).map((i: any) => i?.price?.id) });
    return { outcome: 'skipped', decision, sub, tier };
  }
  const custId = sub.customer as string;
  const clerkUserId = extra.clerkUserId ?? resolveClerkUserId(sub.metadata, null);
  const email = extra.email !== undefined ? extra.email : await emailFromCustomer(stripe, custId);
  const county = extra.county !== undefined ? extra.county : resolveSelectedCounty(sub.metadata);
  const outcome = await provision(stripe, clerk, alert, {
    email, tier, customerId: custId, subId: sub.id, clerkUserId, county, paused,
    billingStatus: decision.billingStatus, stripeStatus: sub.status,
  }, ctx);
  return { outcome, decision, sub, tier };
}


// Conversion rule (decided): a subscription's FIRST successful paid invoice ever is the acquisition conversion; every later paid
// invoice is a renewal and must not be reported as a new conversion. billing_reason cannot be used: with a trial the first invoice is $0
// ('subscription_create') and the first PAID one is a 'subscription_cycle'. READ-ONLY. Returns null when it cannot be determined
// (the caller then does NOT emit — never guess a conversion — and entitlement handling continues unaffected).
export async function isAcquisitionInvoice(stripe: StripeLike, subId: string, inv: any): Promise<boolean | null> {
  if (!stripe.invoices?.list) return null;
  try {
    const page = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 100 });
    if (page.has_more) return false; // >100 paid invoices: this is certainly not the first
    const paid = new Map<string, any>();
    for (const i of page.data || []) if ((i.amount_paid || 0) > 0) paid.set(i.id, i);
    if ((inv.amount_paid || 0) > 0 && inv.id) paid.set(inv.id, inv); // the event's own invoice counts even if the list lags
    const ordered = [...paid.values()].sort((a, b) => ((a.created || 0) - (b.created || 0)) || String(a.id).localeCompare(String(b.id)));
    return ordered.length > 0 && ordered[0].id === inv.id;
  } catch { return null; }
}

const NO_EMIT = new Set<Outcome>(['duplicate_event', 'stale_event', 'skipped']);

// Route the parsed Stripe event to provisioning. Returns nothing; throws on transient
// errors (caller maps to 500 → Stripe retry). Never silent: alerts on missing identity.
export async function handleStripeEvent(
  stripe: StripeLike, clerk: ClerkLike, event: any, cb: { emit: Emit; alert: Alert },
): Promise<void> {
  const { emit, alert } = cb;
  const ctx: EventCtx = { eventId: event.id || null, eventCreated: typeof event.created === 'number' ? event.created : null };
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const email = s.customer_email || s.customer_details?.email || null;
    const subId = s.subscription as string; const custId = s.customer as string;
    if (subId && custId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      const clerkUserId = resolveClerkUserId(s.metadata, s.client_reference_id) || resolveClerkUserId(sub.metadata, null);
      const county = resolveSelectedCounty(s.metadata) || resolveSelectedCounty(sub.metadata);
      const r = await reconcileSubscription(stripe, clerk, alert, { ...sub, id: sub.id || subId, customer: sub.customer || custId },
        { email, clerkUserId, county, useEventSnapshot: true, ...ctx });
      if (r.decision.action === 'grant' && !NO_EMIT.has(r.outcome)) {
        await emit('trial_started', { client_reference_id: s.client_reference_id || undefined, stripe_session_id: s.id, stripe_subscription_id: subId, email: email || undefined, plan: r.tier!, properties: { customer_id: custId, subscription_status: sub.status, clerk_user_id: clerkUserId || undefined } });
      }
    }
  } else if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.paid') {
    const inv = event.data.object;
    // The subscription reference moved under `parent.subscription_details` on newer Stripe API versions.
    const subId = (inv.subscription || inv.parent?.subscription_details?.subscription) as string;
    if ((inv.amount_paid || 0) > 0 && subId) {
      // Classified BEFORE any state change (read-only), so a transient failure cannot lose the conversion via the replay guard.
      const acquisition = await isAcquisitionInvoice(stripe, subId, inv);
      if (acquisition === null) alert('conversion_classification_unavailable', { subscription_id: subId, invoice_id: inv.id });
      const sub = await stripe.subscriptions.retrieve(subId);
      const email = inv.customer_email || (await emailFromCustomer(stripe, sub.customer as string));
      const r = await reconcileSubscription(stripe, clerk, alert, { ...sub, id: sub.id || subId }, { email, useEventSnapshot: true, ...ctx });
      if (r.decision.action === 'grant' && !NO_EMIT.has(r.outcome) && acquisition === true) {
        await emit('paid_subscription_started', { stripe_subscription_id: subId, email: email || undefined, plan: r.tier!, properties: { conversion_basis: 'first_paid_invoice', invoice_id: inv.id, amount_paid: inv.amount_paid, clerk_user_id: resolveClerkUserId(sub.metadata, null) || undefined } });
      }
    }
  } else if (event.type === 'invoice.payment_failed') {
    // Failed payment: never leave stale 'active'. Reconcile from Stripe's CURRENT subscription state
    // (past_due → billing_status past_due; unpaid/canceled → revoked). Alerts the owner either way.
    const inv = event.data.object;
    const subId = (inv.subscription || inv.parent?.subscription_details?.subscription) as string;
    alert('payment_failed', { invoice_id: inv.id, subscription_id: subId, customer_id: inv.customer, attempt_count: inv.attempt_count });
    if (subId) {
      const sub = await stripe.subscriptions.retrieve(subId);
      await reconcileSubscription(stripe, clerk, alert, { ...sub, id: sub.id || subId }, { ...ctx });
    }
  } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    // `deleted` is terminal by definition; trust it even if Stripe's retrieve is momentarily stale.
    const snapshot = event.type === 'customer.subscription.deleted' ? { ...sub, status: 'canceled' } : sub;
    await reconcileSubscription(stripe, clerk, alert, snapshot, { ...ctx, useEventSnapshot: event.type === 'customer.subscription.deleted' });
  } else if (event.type === 'customer.subscription.trial_will_end') {
    // Seam 3 — trial → first-charge interlock. Stripe fires this ~3 days before the trial ends.
    // If the canonical onboarding contract is NOT complete, withhold the first charge by pausing
    // collection (reversible), preserving the subscription + data. Prevents the Freitas failure
    // (a customer charged for a product that was never deliverable). Does NOT enable delivery
    // enforcement and never cancels/refunds.
    const sub = event.data.object;
    const tier = tierForSubscription(sub);
    if (!tier) { alert('unknown_price', { subscription_id: sub.id, customer_id: sub.customer, price_ids: (sub.items?.data || []).map((i: any) => i?.price?.id) }); return; }
    const custId = sub.customer as string;
    const clerkUserId = resolveClerkUserId(sub.metadata, null);
    const pm = clerkUserId ? await readPublicMetadata(clerk, clerkUserId) : null;
    const email = pm?.delivery_email || (await emailFromCustomer(stripe, custId));
    const decision = interlockDecision({
      tier, subStatus: 'trialing',
      selected_counties: pm?.selected_counties, selected_trades: pm?.selected_trades, email,
    });
    // Idempotent: if the interlock is ALREADY applied (pause_collection set), a re-delivered or
    // duplicate trial_will_end event is a strict no-op — no second pause, no duplicate/misleading
    // emit. Setting pause is itself idempotent in Stripe, but we also avoid re-emitting.
    if (sub.pause_collection) {
      // already interlocked — nothing to do
    } else if (decision.action === 'pause') {
      await stripe.subscriptions.update(sub.id, PAUSE_PARAMS);
      alert('billing_interlock_triggered', {
        subscription_id: sub.id, customer_id: custId, clerk_user_id: clerkUserId || undefined,
        tier, state: decision.state, reason: decision.reason,
      });
      await emit('billing_interlock_triggered', {
        stripe_subscription_id: sub.id, email: email || undefined, plan: tier,
        properties: { customer_id: custId, clerk_user_id: clerkUserId || undefined, lifecycle_state: decision.state, reason: decision.reason },
      });
    } else {
      await emit('trial_product_ready', {
        stripe_subscription_id: sub.id, email: email || undefined, plan: tier,
        properties: { customer_id: custId, clerk_user_id: clerkUserId || undefined, lifecycle_state: decision.state },
      });
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
