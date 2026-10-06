// Rollback manifest generation (pure). If the cutover fails after Stripe was re-linked, we must be
// able to restore each Stripe customer/subscription's clerk_user_id to its ORIGINAL dev value. This
// produces the reverse plan (new→old). Env/deploy rollback (Clerk keys, Vercel deploy) is operational
// and documented in README.md; this covers the only DATA mutation the migration performs (Stripe).

import { MigrationRow } from './manifest';
import { planStripeRelink, StripeMutation } from './stripe-relink';

/** Reverse Stripe relink: swap old/new so clerk_user_id is restored to the dev id. Only meaningful
 *  for rows that were actually relinked; caller filters by migration_status if desired. */
export function buildStripeRollback(rows: MigrationRow[]): StripeMutation[] {
  return planStripeRelink(rows).map((m) => ({
    ...m,
    old_value: m.new_value,   // currently prod id
    new_value: m.old_value,   // restore dev id
  }));
}

/** A full rollback manifest: the reverse Stripe mutations + a note on the operational (env/deploy)
 *  steps that must accompany them. */
export function buildRollbackManifest(rows: MigrationRow[]): {
  stripe_restore: StripeMutation[];
  operational_steps: string[];
} {
  return {
    stripe_restore: buildStripeRollback(rows),
    operational_steps: [
      // SAFETY: this template must never tell an operator to point production at a different Clerk instance. Production Clerk
      // is live (sk_live_/pk_live_); reverting to development keys would orphan every production user and every new checkout.
      'DO NOT change Vercel Clerk keys (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY) as part of rolling back a Stripe metadata relink. They are paired and belong to the PRODUCTION Clerk instance.',
      'Restore Stripe metadata by applying stripe_restore (customer + subscription metadata.clerk_user_id back to the recorded old value) with a live Stripe key. This is the ONLY data mutation the relink performs.',
      'Verify afterwards with scripts/prod-entitlement-reconcile.ts (it refuses a non-production Clerk key and stamps instances.{stripe,clerk} into its report).',
      'If a deployment must be rolled back, use the Vercel rollback of the recorded prior deployment (DEPLOYED_COMMIT_BEFORE); never edit Clerk keys to do it.',
      'Any change of Clerk instance is a separate, reviewed cutover runbook, not a rollback step.',
    ],
  };
}
