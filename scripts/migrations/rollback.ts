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
      'Restore Vercel Production env: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ (dev), CLERK_SECRET_KEY=sk_test_ (dev), CLERK_WEBHOOK_SECRET=(dev)',
      'Redeploy the prior Vercel deployment (recorded DEPLOYED_COMMIT_BEFORE)',
      'Leave newly-created prod Clerk users in place (harmless; they are unreferenced once frontend reverts to dev)',
      'Apply stripe_restore ONLY if Stripe was relinked before the failure (see cutover order: relink AFTER a validated staging check, so most rollbacks need no Stripe restore)',
    ],
  };
}
