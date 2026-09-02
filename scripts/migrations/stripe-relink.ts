// Stripe re-link tooling (dependency-injected, DRY-RUN BY DEFAULT). After prod Clerk users are
// created, the clerk_user_id stamped on each Stripe customer + subscription still points at the OLD
// dev user id (see dashboard lib/provisioning.ts lines that set metadata.clerk_user_id, and
// checkout-session.ts client_reference_id). This plans/applies the re-point old→new. It NEVER mutates
// Stripe unless apply:true is explicitly passed AND a real client is injected.

import { MigrationRow, isBillingRow } from './manifest';

export interface StripeMutation {
  customer_id: string;
  subscription_id: string | null;
  target: 'customer.metadata.clerk_user_id' | 'subscription.metadata.clerk_user_id';
  old_value: string;   // dev clerk user id currently in Stripe metadata
  new_value: string;   // prod clerk user id to write
}

// Minimal injected Stripe surface (matches the real `stripe` client shape; unit tests pass a spy).
export interface StripeLike {
  customers: { update: (id: string, params: { metadata: Record<string, string> }) => Promise<unknown> };
  subscriptions: { update: (id: string, params: { metadata: Record<string, string> }) => Promise<unknown> };
}

/** PURE: compute the exact Stripe field mutations a full relink would perform. No client, no writes. */
export function planStripeRelink(rows: MigrationRow[]): StripeMutation[] {
  const out: StripeMutation[] = [];
  for (const r of rows) {
    if (!isBillingRow(r) || !r.new_prod_user_id) continue;
    if (r.stripe_customer_id) {
      out.push({ customer_id: r.stripe_customer_id, subscription_id: r.stripe_subscription_id ?? null,
        target: 'customer.metadata.clerk_user_id', old_value: r.old_dev_user_id, new_value: r.new_prod_user_id });
    }
    if (r.stripe_subscription_id) {
      out.push({ customer_id: r.stripe_customer_id ?? '', subscription_id: r.stripe_subscription_id,
        target: 'subscription.metadata.clerk_user_id', old_value: r.old_dev_user_id, new_value: r.new_prod_user_id });
    }
  }
  return out;
}

export interface RelinkResult {
  dryRun: boolean;
  planned: StripeMutation[];
  applied: number;
  errors: string[];
}

/** Execute the relink. DEFAULT dry-run: returns the plan and performs ZERO writes. Only with
 *  {apply:true} AND an injected stripe client does it call Stripe. */
export async function runStripeRelink(
  rows: MigrationRow[],
  opts: { apply?: boolean; stripe?: StripeLike } = {},
): Promise<RelinkResult> {
  const planned = planStripeRelink(rows);
  const apply = opts.apply === true;
  if (!apply || !opts.stripe) {
    return { dryRun: true, planned, applied: 0, errors: [] };
  }
  const errors: string[] = [];
  let applied = 0;
  for (const m of planned) {
    try {
      if (m.target === 'customer.metadata.clerk_user_id') {
        await opts.stripe.customers.update(m.customer_id, { metadata: { clerk_user_id: m.new_value } });
      } else if (m.subscription_id) {
        await opts.stripe.subscriptions.update(m.subscription_id, { metadata: { clerk_user_id: m.new_value } });
      }
      applied++;
    } catch (e) {
      errors.push(`${m.target} ${m.customer_id || m.subscription_id}: ${String(e).slice(0, 160)}`);
    }
  }
  return { dryRun: false, planned, applied, errors };
}
