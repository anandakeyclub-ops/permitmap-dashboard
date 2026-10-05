// PURE planner: derives the old-Clerk-ID → production-Clerk-ID relink manifest by matching the IMMUTABLE
// Stripe subscription id. No SDK, no network, no writes. The caller feeds it read-only snapshots.
//
// Anchor: a production Clerk user whose publicMetadata.stripe_subscription_id = S claims Stripe subscription S.
// Stripe subscription S carries metadata.clerk_user_id = <old dev id>. old → new is therefore proven by S itself.
// Every mapping must pass all proofs; anything ambiguous is excluded and reported, never guessed.
import type { MigrationRow } from './manifest';

export interface StripeSubIn { id: string; status: string; customer: string; clerk_user_id: string | null; tier: string | null }
export interface StripeCustomerIn { id: string; deleted?: boolean; clerk_user_id: string | null; email: string | null }
export interface ClerkUserIn { id: string; email: string | null; publicMetadata: Record<string, any> }

export type Decision = 'PROVEN' | 'ALREADY_LINKED' | 'CONFLICT' | 'REVIEW';
export interface RowDecision {
  new_prod_user_id: string; stripe_subscription_id: string; stripe_customer_id: string | null; old_dev_user_id: string | null;
  decision: Decision; accepted_by_operator?: boolean; reasons: string[];
  proofs: { sub_exists: boolean; unique_claim: boolean; old_id_present: boolean; old_not_a_live_user: boolean; customer_consistent: boolean;
            customer_meta_consistent: boolean; one_to_one: boolean; email_corroborated: boolean | null };
  info: { stripe_status: string | null; stripe_tier: string | null; clerk_tier: string | null; clerk_billing: string | null };
}
export interface RelinkPlan {
  rows: MigrationRow[]; decisions: RowDecision[];
  unclaimed_live_stripe_subs: string[]; verdict: 'READY' | 'BLOCKED'; blockers: string[];
  counts: Record<Decision, number>;
}

const norm = (e: string | null | undefined) => (e || '').trim().toLowerCase() || null;
const LIVE = new Set(['active', 'trialing', 'past_due']);

export function buildRelinkPlan(input: { subs: StripeSubIn[]; customers: StripeCustomerIn[]; clerkUsers: ClerkUserIn[]; acceptReview?: string[] }): RelinkPlan {
  const subById = new Map(input.subs.map(s => [s.id, s]));
  const custById = new Map(input.customers.map(c => [c.id, c]));
  const liveUserIds = new Set(input.clerkUsers.map(u => u.id));
  const accept = new Set(input.acceptReview || []);

  const claimants = input.clerkUsers.filter(u => typeof u.publicMetadata?.stripe_subscription_id === 'string' && u.publicMetadata.stripe_subscription_id);
  const claimCount = new Map<string, number>();
  for (const u of claimants) claimCount.set(u.publicMetadata.stripe_subscription_id, (claimCount.get(u.publicMetadata.stripe_subscription_id) || 0) + 1);

  // First pass: per-row proofs that need no cross-row knowledge.
  const draft: RowDecision[] = claimants.map(u => {
    const pm = u.publicMetadata; const sid: string = pm.stripe_subscription_id;
    const sub = subById.get(sid) || null; const cust = sub ? custById.get(sub.customer) || null : null;
    const reasons: string[] = []; let hard = false; let soft = false;
    const sub_exists = !!sub; if (!sub_exists) { reasons.push('Stripe subscription not found'); hard = true; }
    const unique_claim = (claimCount.get(sid) || 0) === 1; if (!unique_claim) { reasons.push(`subscription claimed by ${claimCount.get(sid)} Clerk users`); hard = true; }
    const old = sub?.clerk_user_id ?? null;
    const old_id_present = !!old; if (sub && !old) { reasons.push('Stripe subscription has no prior clerk_user_id (nothing to re-point from)'); soft = true; }
    const old_not_a_live_user = !(old && old !== u.id && liveUserIds.has(old));
    if (!old_not_a_live_user) { reasons.push(`Stripe points at ${old}, which is a DIFFERENT existing production user`); hard = true; }
    const customer_consistent = !(pm.stripe_customer_id && sub && pm.stripe_customer_id !== sub.customer);
    if (!customer_consistent) { reasons.push(`Clerk stripe_customer_id ${pm.stripe_customer_id} != Stripe subscription customer ${sub?.customer}`); hard = true; }
    if (sub && (!cust || cust.deleted)) { reasons.push('Stripe customer missing/deleted'); hard = true; }
    const custMeta = cust?.clerk_user_id ?? null;
    const customer_meta_consistent = !custMeta || custMeta === old || custMeta === u.id;
    if (!customer_meta_consistent) { reasons.push(`customer.metadata.clerk_user_id=${custMeta} matches neither old (${old}) nor new (${u.id})`); hard = true; }
    let email_corroborated: boolean | null = null;
    if (cust && !cust.deleted) { const a = norm(cust.email), b = norm(u.email); email_corroborated = a && b ? a === b : null; }
    if (email_corroborated !== true) { reasons.push(email_corroborated === false ? 'Stripe customer email != Clerk primary email' : 'email corroboration unavailable'); soft = true; }
    let decision: Decision = hard ? 'CONFLICT' : 'PROVEN';
    if (!hard && old && old === u.id) { decision = 'ALREADY_LINKED'; }
    else if (!hard && soft) decision = 'REVIEW';
    return {
      new_prod_user_id: u.id, stripe_subscription_id: sid, stripe_customer_id: sub?.customer ?? null, old_dev_user_id: old, decision, reasons,
      proofs: { sub_exists, unique_claim, old_id_present, old_not_a_live_user, customer_consistent, customer_meta_consistent, one_to_one: true, email_corroborated },
      info: { stripe_status: sub?.status ?? null, stripe_tier: sub?.tier ?? null, clerk_tier: pm.tier ?? null, clerk_billing: pm.billing_status ?? null },
    };
  });

  // Second pass: cross-row one-to-one proofs (fan-in on an old id, or one customer relinked to two different users).
  const byOld = new Map<string, RowDecision[]>(); const byCust = new Map<string, RowDecision[]>();
  for (const d of draft) {
    if (d.old_dev_user_id && d.decision !== 'ALREADY_LINKED') (byOld.get(d.old_dev_user_id) || byOld.set(d.old_dev_user_id, []).get(d.old_dev_user_id)!).push(d);
    if (d.stripe_customer_id) (byCust.get(d.stripe_customer_id) || byCust.set(d.stripe_customer_id, []).get(d.stripe_customer_id)!).push(d);
  }
  const demote = (d: RowDecision, why: string) => { d.proofs.one_to_one = false; d.reasons.push(why); d.decision = 'CONFLICT'; };
  for (const [old, ds] of byOld) if (new Set(ds.map(d => d.new_prod_user_id)).size > 1) ds.forEach(d => demote(d, `old id ${old} maps to multiple production users`));
  for (const [c, ds] of byCust) if (new Set(ds.map(d => d.new_prod_user_id)).size > 1) ds.forEach(d => demote(d, `customer ${c} is claimed by multiple production users`));

  // Explicit operator acceptance can lift REVIEW only (never CONFLICT).
  for (const d of draft) if (d.decision === 'REVIEW' && accept.has(d.stripe_subscription_id)) { d.decision = 'PROVEN'; d.accepted_by_operator = true; }

  const rows: MigrationRow[] = draft.filter(d => d.decision === 'PROVEN').map(d => {
    const u = input.clerkUsers.find(x => x.id === d.new_prod_user_id)!;
    return {
      old_dev_user_id: d.old_dev_user_id!, new_prod_user_id: d.new_prod_user_id, primary_email: `redacted:${d.new_prod_user_id}`,
      stripe_customer_id: d.stripe_customer_id, stripe_subscription_id: d.stripe_subscription_id,
      billing_status: u.publicMetadata.billing_status ?? null, tier: u.publicMetadata.tier ?? null,
      public_metadata: {}, migration_status: 'CREATED_IN_PROD' as const,
    };
  });

  const claimed = new Set(claimants.map(u => u.publicMetadata.stripe_subscription_id));
  const unclaimed_live_stripe_subs = input.subs.filter(s => LIVE.has(s.status) && !claimed.has(s.id)).map(s => s.id);
  const counts: Record<Decision, number> = { PROVEN: 0, ALREADY_LINKED: 0, CONFLICT: 0, REVIEW: 0 };
  draft.forEach(d => counts[d.decision]++);
  const blockers: string[] = [];
  if (counts.CONFLICT) blockers.push(`${counts.CONFLICT} CONFLICT row(s)`);
  if (counts.REVIEW) blockers.push(`${counts.REVIEW} row(s) need operator review (--accept-review <sub_id,...>)`);
  if (unclaimed_live_stripe_subs.length) blockers.push(`${unclaimed_live_stripe_subs.length} live Stripe subscription(s) claimed by no Clerk user`);
  return { rows, decisions: draft, unclaimed_live_stripe_subs, verdict: blockers.length ? 'BLOCKED' : 'READY', blockers, counts };
}
