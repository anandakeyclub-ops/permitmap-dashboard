/**
 * READ-ONLY dry-run of the production entitlement code path over live Stripe + production Clerk. Zero writes: Clerk/Stripe writes are captured in an overlay.
 *   STRIPE_SECRET_KEY=rk_live_… CLERK_SECRET_KEY=sk_live_… npx vite-node scripts/reconcile-dry-run.ts [--out reconcile-dry-run.json]
 * Shows, per user: before → after (what replaying Stripe truth would change), whether the result matches Stripe truth, and which replays would
 * ERROR in production (e.g. a Stripe subscription pointing at a deleted Clerk user would 500 the webhook forever).
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { writeFileSync } from 'node:fs';
import { readOnly } from './readonly-guard';
import { assertProductionInstances } from './instance-guard';
import { runDryReconcile } from './reconcile-dry-run-core';

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
async function main() {
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  if (!sk || !ck) { console.error('Set STRIPE_SECRET_KEY and CLERK_SECRET_KEY'); process.exit(2); }
  let inst; try { inst = assertProductionInstances(sk, ck); } catch (e: any) { console.error(e.message); process.exit(2); }
  console.log(inst.banner);
  const stripe: any = readOnly('stripe', new Stripe(sk, { apiVersion: '2023-10-16' as any }));
  const clerk: any = readOnly('clerk', createClerkClient({ secretKey: ck }));
  const subs: any[] = []; for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) subs.push(s);
  const users: any[] = []; for (let o = 0; ; o += 500) { const p: any = await clerk.users.getUserList({ limit: 500, offset: o }); const r = Array.isArray(p) ? p : p.data; users.push(...r); if (r.length < 500) break; }
  const report = await runDryReconcile({ stripe, stripeSubs: subs, clerkUsers: users.map(u => ({ id: u.id, publicMetadata: u.publicMetadata || {} })), clerkGetUserList: (p: any) => clerk.users.getUserList(p) });
  writeFileSync(arg('--out') || 'reconcile-dry-run.json', JSON.stringify({ instances: { stripe: inst.stripe, clerk: inst.clerk }, generated_at: new Date().toISOString(), ...report }, null, 2));
  console.log('SUMMARY', JSON.stringify(report.summary));
  for (const r of report.rows.filter(r => r.changed || r.would_error.length || !r.converges))
    console.log(`${r.would_error.length ? 'ERROR ' : r.converges ? 'CHANGE' : 'NOCONV'} ${r.clerk_user_id}: ${r.before.tier}/${r.before.billing_status} → ${r.after.tier}/${r.after.billing_status} (truth ${r.expected.tier}/${r.expected.billing}) subs=[${r.subs_replayed.join(' ')}]${r.would_error.length ? ' errors=' + r.would_error.join('; ') : ''}${r.alerts.length ? ' alerts=' + r.alerts.map(a => a.kind).join(',') : ''}`);
  if (report.manual_or_legacy.length) console.log('MANUAL/LEGACY (never touched):', report.manual_or_legacy.join(', '));
  report.orphan_stripe_subs.forEach(o => console.log(`ORPHAN STRIPE SUB ${o.sub} ${o.status} metadata.clerk_user_id=${o.metadata_clerk_user_id}`));
  console.log('READ-ONLY run: all writes were captured in an overlay and discarded.');
}
main().catch(e => { console.error(e); process.exit(1); });
