/**
 * READ-ONLY production verification: (A) Stripe webhook registration / API version, (B) Stripe ↔ Clerk entitlement reconciliation.
 *
 *   STRIPE_SECRET_KEY=<live key, ideally a RESTRICTED READ-ONLY key> CLERK_SECRET_KEY=<live> \
 *     npx vite-node scripts/prod-entitlement-reconcile.ts [--out report.json]
 *
 * Safety: both SDK clients are wrapped so ONLY list/retrieve/search/getUser/getUserList calls can execute; any other
 * method throws before a request is made. No emails or names are printed or written: only Clerk user ids, Stripe ids, tiers, statuses.
 * Classification lives in lib/revenue-integrity.ts (shared with the /api/internal/revenue-integrity monitor route), which uses the SAME
 * decision functions as production (entitlementForStatus / tierForSubscription) so "expected" cannot drift from the code.
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { writeFileSync } from 'node:fs';
import { readOnly } from './readonly-guard';
import { assertProductionInstances } from './instance-guard';
import { EXPECTED_API_VERSION, webhookFindings, reconcileEntitlements } from '../lib/revenue-integrity';

async function main() {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'prod-entitlement-report.json';
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  if (!sk || !ck) { console.error('Set STRIPE_SECRET_KEY and CLERK_SECRET_KEY.'); process.exit(2); }
  let inst: ReturnType<typeof assertProductionInstances>;
  try { inst = assertProductionInstances(sk, ck); } catch (e: any) { console.error(e.message); process.exit(2); }
  console.log(inst.banner);
  const stripe = readOnly('stripe', new Stripe(sk, { apiVersion: EXPECTED_API_VERSION as any }));
  const clerk = readOnly('clerk', createClerkClient({ secretKey: ck }));
  const report: any = { instances: { stripe: inst.stripe, clerk: inst.clerk }, generated_at: new Date().toISOString(), mode: sk.startsWith('rk_') ? 'restricted_key' : 'secret_key', A_webhooks: {}, B_reconcile: {} };

  // ---------- A. webhook registration ----------
  const eps: any[] = [];
  for await (const e of (stripe as any).webhookEndpoints.list({ limit: 100 })) eps.push(e);
  report.A_webhooks = {
    total_endpoints: eps.length,
    endpoints: eps.map(e => ({ id: e.id, url: e.url, status: e.status, api_version: e.api_version, livemode: e.livemode, enabled_events: e.enabled_events })),
    findings: webhookFindings(eps),
  };

  // ---------- B. reconciliation ----------
  const subs: any[] = [];
  for await (const s of (stripe as any).subscriptions.list({ status: 'all', limit: 100 })) subs.push(s);
  const users: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const page: any = await (clerk as any).users.getUserList({ limit: 500, offset });
    const rows = Array.isArray(page) ? page : page.data;
    users.push(...rows); if (rows.length < 500) break;
  }
  const section = reconcileEntitlements(subs, users);
  const { counts: bucket, unmapped_stripe_subscriptions: unmapped } = section;
  report.B_reconcile = section;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('=== A. WEBHOOK ===');  report.A_webhooks.findings.forEach((f: string) => console.log(' ', f));
  console.log('=== B. RECONCILIATION ===', JSON.stringify(bucket));
  console.log(`  stripe subs: ${subs.length}  clerk users: ${users.length}  unmapped stripe subs: ${unmapped.length}`);
  for (const r of report.B_reconcile.discrepancies) console.log(`  ${r.class}: ${r.clerk_user_id} clerk=${r.clerk_tier}/${r.clerk_billing} expected=${r.expected_tier}/${r.expected_billing} stripe=[${r.stripe_subs.join(' ')}]`);
  console.log(`report written: ${out}  (READ-ONLY run; no Stripe/Clerk writes possible)`);
}
main().catch(e => { console.error(e); process.exit(1); });
