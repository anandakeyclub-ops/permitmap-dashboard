/**
 * READ-ONLY, DRY-RUN-ONLY. Builds + proves the old-Clerk-ID → production-Clerk-ID relink manifest from live Stripe + Clerk,
 * runs the repository's runStripeRelink in dry-run, and writes the manifest, a proof report and the rollback manifest.
 * This CLI has NO apply path: it never injects a Stripe client into runStripeRelink and both SDK clients are read-only guarded.
 *
 *   STRIPE_SECRET_KEY=rk_live_… CLERK_SECRET_KEY=sk_live_… npx vite-node scripts/migrations/build-relink-manifest.ts [--out-dir DIR] [--accept-review sub_a,sub_b]
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readOnly } from '../readonly-guard';
import { assertProductionInstances } from '../instance-guard';
import { tierForSubscription } from '../../lib/provisioning';
import { buildRelinkPlan } from './relink-manifest';
import { runStripeRelink } from './stripe-relink';
import { validateForApply } from './manifest';
import { buildRollbackManifest } from './rollback';

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);

async function main() {
  const dir = arg('--out-dir') || '.'; mkdirSync(dir, { recursive: true });
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  if (!sk || !ck) { console.error('Set STRIPE_SECRET_KEY and CLERK_SECRET_KEY'); process.exit(2); }
  let inst: ReturnType<typeof assertProductionInstances>;
  try { inst = assertProductionInstances(sk, ck); } catch (e: any) { console.error(e.message); process.exit(2); }
  console.log(inst.banner);
  const stripe: any = readOnly('stripe', new Stripe(sk, { apiVersion: '2023-10-16' as any }));
  const clerk: any = readOnly('clerk', createClerkClient({ secretKey: ck }));

  const subsRaw: any[] = []; for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) subsRaw.push(s);
  const custIds = [...new Set(subsRaw.map(s => (typeof s.customer === 'string' ? s.customer : s.customer?.id)))];
  const customers = [];
  for (const id of custIds) {
    const c: any = await stripe.customers.retrieve(id);
    customers.push({ id, deleted: !!c.deleted, clerk_user_id: c.metadata?.clerk_user_id ?? null, email: c.email ?? null });
  }
  const users: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const page: any = await clerk.users.getUserList({ limit: 500, offset }); const rows = Array.isArray(page) ? page : page.data;
    users.push(...rows); if (rows.length < 500) break;
  }
  const plan = buildRelinkPlan({
    subs: subsRaw.map(s => ({ id: s.id, status: s.status, customer: typeof s.customer === 'string' ? s.customer : s.customer.id, clerk_user_id: s.metadata?.clerk_user_id ?? null, tier: tierForSubscription(s) })),
    customers,
    clerkUsers: users.map(u => ({ id: u.id, publicMetadata: u.publicMetadata || {}, email: u.emailAddresses?.find((e: any) => e.id === u.primaryEmailAddressId)?.emailAddress ?? u.emailAddresses?.[0]?.emailAddress ?? null })),
    acceptReview: (arg('--accept-review') || '').split(',').filter(Boolean),
  });

  const dry = await runStripeRelink(plan.rows); // dry-run: no client injected, zero writes (asserted below)
  if (!dry.dryRun || dry.applied !== 0) throw new Error('invariant: relink must be dry-run');
  const gate = validateForApply(plan.rows);
  const report = {
    instances: { stripe: inst.stripe, clerk: inst.clerk }, generated_at: new Date().toISOString(), verdict: plan.verdict, blockers: plan.blockers, counts: plan.counts,
    stripe_subscriptions: subsRaw.length, clerk_users: users.length, unclaimed_live_stripe_subs: plan.unclaimed_live_stripe_subs,
    decisions: plan.decisions, planned_stripe_mutations: dry.planned, validateForApply: gate,
  };
  writeFileSync(`${dir}/relink-manifest.json`, JSON.stringify({ clerk_instance: inst.clerk, rows: plan.rows }, null, 2));
  writeFileSync(`${dir}/relink-proof-report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${dir}/relink-rollback.json`, JSON.stringify(buildRollbackManifest(plan.rows), null, 2));

  console.log(`VERDICT: ${plan.verdict}  ${JSON.stringify(plan.counts)}  stripe_subs=${subsRaw.length} clerk_users=${users.length}`);
  plan.blockers.forEach(b => console.log('  BLOCKER:', b));
  for (const d of plan.decisions) console.log(`  ${d.decision.padEnd(14)} ${d.stripe_subscription_id} ${d.old_dev_user_id ?? '∅'} → ${d.new_prod_user_id}  stripe=${d.info.stripe_status}/${d.info.stripe_tier} clerk=${d.info.clerk_tier}/${d.info.clerk_billing} email_ok=${d.proofs.email_corroborated}${d.reasons.length ? '  ! ' + d.reasons.join('; ') : ''}`);
  console.log(`planned Stripe mutations (NOT applied): ${dry.planned.length}; validateForApply ok=${gate.ok}`);
  console.log(`wrote ${dir}/relink-manifest.json, relink-proof-report.json, relink-rollback.json  (DRY RUN — no Stripe/Clerk writes occurred or are possible from this tool)`);
}
main().catch(e => { console.error(e); process.exit(1); });
