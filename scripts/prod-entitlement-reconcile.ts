/**
 * READ-ONLY production verification: (A) Stripe webhook registration / API version, (B) Stripe ↔ Clerk entitlement reconciliation.
 *
 *   STRIPE_SECRET_KEY=<live key, ideally a RESTRICTED READ-ONLY key> CLERK_SECRET_KEY=<live> \
 *     npx vite-node scripts/prod-entitlement-reconcile.ts [--out report.json]
 *
 * Safety: both SDK clients are wrapped so ONLY list/retrieve/search/getUser/getUserList calls can execute; any other
 * method throws before a request is made. No emails or names are printed or written: only Clerk user ids, Stripe ids, tiers, statuses.
 * Uses the SAME decision functions as production (entitlementForStatus / tierForSubscription) so "expected" cannot drift from the code.
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { writeFileSync } from 'node:fs';
import { readOnly } from './readonly-guard';
import { entitlementForStatus, tierForSubscription } from '../lib/provisioning';

const REQUIRED_EVENTS = [
  'checkout.session.completed', 'invoice.payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
];
const PAID_EVENT_ANY_OF = ['invoice.payment_succeeded', 'invoice.paid'];
const EXPECTED_API_VERSION = '2023-10-16';
const WEBHOOK_PATH = '/api/stripe-webhook';
const RANK: Record<string, number> = { starter: 1, pro: 2, team: 3 };
const PAID_TIERS = new Set(Object.keys(RANK));
async function main() {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'prod-entitlement-report.json';
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  if (!sk || !ck) { console.error('Set STRIPE_SECRET_KEY and CLERK_SECRET_KEY.'); process.exit(2); }
  if (sk.startsWith('sk_test_')) { console.error('This is the PRODUCTION verifier; got a test Stripe key. Refusing.'); process.exit(2); }
  const stripe = readOnly('stripe', new Stripe(sk, { apiVersion: EXPECTED_API_VERSION as any }));
  const clerk = readOnly('clerk', createClerkClient({ secretKey: ck }));
  const report: any = { generated_at: new Date().toISOString(), mode: sk.startsWith('rk_') ? 'restricted_key' : 'secret_key', A_webhooks: {}, B_reconcile: {} };

  // ---------- A. webhook registration ----------
  const eps: any[] = [];
  for await (const e of (stripe as any).webhookEndpoints.list({ limit: 100 })) eps.push(e);
  const prod = eps.filter(e => String(e.url).includes('permitmap.org') && String(e.url).includes(WEBHOOK_PATH));
  report.A_webhooks = {
    total_endpoints: eps.length,
    endpoints: eps.map(e => ({ id: e.id, url: e.url, status: e.status, api_version: e.api_version, livemode: e.livemode, enabled_events: e.enabled_events })),
    findings: [] as string[],
  };
  const F: string[] = report.A_webhooks.findings;
  if (prod.length === 0) F.push('CRITICAL: no endpoint registered for permitmap.org' + WEBHOOK_PATH);
  if (prod.length > 1) F.push(`WARN: ${prod.length} endpoints target the production route (duplicate delivery; idempotency covers it, but verify intent)`);
  for (const e of prod) {
    if (e.status !== 'enabled') F.push(`CRITICAL: ${e.id} status=${e.status}`);
    if (!e.livemode) F.push(`CRITICAL: ${e.id} is a test-mode endpoint`);
    if (e.api_version !== EXPECTED_API_VERSION) F.push(`WARN: ${e.id} api_version=${e.api_version ?? 'account default'} (route client pins ${EXPECTED_API_VERSION}; event payload shape follows the ENDPOINT version)`);
    const ev: string[] = e.enabled_events || [];
    const all = ev.includes('*');
    const missing = all ? [] : REQUIRED_EVENTS.filter(r => !ev.includes(r));
    if (!all && !PAID_EVENT_ANY_OF.some(r => ev.includes(r))) missing.push('invoice.payment_succeeded|invoice.paid');
    if (missing.length) F.push(`CRITICAL: ${e.id} missing events: ${missing.join(', ')}`);
  }
  if (!F.length) F.push('OK: production endpoint enabled, livemode, required events registered, API version matches');

  // ---------- B. reconciliation ----------
  const subs: any[] = [];
  for await (const s of (stripe as any).subscriptions.list({ status: 'all', limit: 100 })) subs.push(s);
  const byUser = new Map<string, any[]>(); const unmapped: any[] = [];
  for (const s of subs) { const u = s.metadata?.clerk_user_id; if (u) { (byUser.get(u) || byUser.set(u, []).get(u)!).push(s); } else unmapped.push(s); }
  const users: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const page: any = await (clerk as any).users.getUserList({ limit: 500, offset });
    const rows = Array.isArray(page) ? page : page.data;
    users.push(...rows); if (rows.length < 500) break;
  }
  const clerkById = new Map(users.map(u => [u.id, u]));
  const rows: any[] = []; const bucket: Record<string, number> = {};
  const mark = (cls: string, row: any) => { bucket[cls] = (bucket[cls] || 0) + 1; rows.push({ class: cls, ...row }); };

  const expectedFor = (mine: any[]) => {
    const entitled = mine.filter(s => entitlementForStatus(s.status, !!s.pause_collection).action === 'grant' && tierForSubscription(s));
    if (entitled.length) {
      entitled.sort((a, b) => RANK[tierForSubscription(b)!] - RANK[tierForSubscription(a)!]);
      const top = entitled[0];
      return { tier: tierForSubscription(top)!, billing: (entitlementForStatus(top.status, !!top.pause_collection) as any).billingStatus, subs: entitled.map(s => s.id) };
    }
    return { tier: null as string | null, billing: null as string | null, subs: [] as string[] };
  };

  const ids = new Set<string>([...byUser.keys(), ...users.filter(u => PAID_TIERS.has(u.publicMetadata?.tier) || u.publicMetadata?.stripe_subscription_id).map(u => u.id)]);
  for (const id of ids) {
    const u = clerkById.get(id); const pm = u?.publicMetadata || {}; const mine = byUser.get(id) || [];
    const exp = expectedFor(mine); const ctier = pm.tier as string | undefined; const cbill = pm.billing_status as string | undefined;
    const base = { clerk_user_id: id, clerk_tier: ctier ?? null, clerk_billing: cbill ?? null, clerk_bound_sub: pm.stripe_subscription_id ?? null, stripe_subs: mine.map(s => `${s.id}:${s.status}:${tierForSubscription(s) ?? 'UNKNOWN_PRICE'}`), expected_tier: exp.tier, expected_billing: exp.billing };
    if (!u) { mark('STRIPE_MAPS_TO_MISSING_CLERK_USER', base); continue; }
    const clerkPaid = PAID_TIERS.has(ctier || '');
    if (exp.tier) {
      if (!clerkPaid) mark('PAYING_CUSTOMER_WITHOUT_ACCESS', base);
      else if (ctier !== exp.tier) mark('TIER_MISMATCH', base);
      else if (cbill !== exp.billing) mark('BILLING_STATUS_MISMATCH', base);
      else if (pm.stripe_subscription_id && !exp.subs.includes(pm.stripe_subscription_id)) mark('BOUND_SUB_NOT_ENTITLED_BUT_ANOTHER_IS', base);
      else mark('OK', base);
    } else {
      if (clerkPaid && !pm.stripe_subscription_id && !mine.length) mark('PAID_TIER_NO_STRIPE_BINDING (comp/manual/legacy?)', base);
      else if (clerkPaid) mark('ACCESS_WITHOUT_ENTITLED_SUBSCRIPTION', base);
      else mark('OK', base);
    }
  }
  report.B_reconcile = {
    stripe_subscriptions_total: subs.length, clerk_users_total: users.length, users_examined: ids.size,
    unmapped_stripe_subscriptions: unmapped.map(s => ({ id: s.id, status: s.status, tier: tierForSubscription(s) ?? 'UNKNOWN_PRICE' })),
    unknown_price_subscriptions: subs.filter(s => ['active', 'trialing', 'past_due'].includes(s.status) && !tierForSubscription(s)).map(s => s.id),
    counts: bucket, discrepancies: rows.filter(r => r.class !== 'OK'),
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('=== A. WEBHOOK ===');  report.A_webhooks.findings.forEach((f: string) => console.log(' ', f));
  console.log('=== B. RECONCILIATION ===', JSON.stringify(bucket));
  console.log(`  stripe subs: ${subs.length}  clerk users: ${users.length}  unmapped stripe subs: ${unmapped.length}`);
  for (const r of report.B_reconcile.discrepancies) console.log(`  ${r.class}: ${r.clerk_user_id} clerk=${r.clerk_tier}/${r.clerk_billing} expected=${r.expected_tier}/${r.expected_billing} stripe=[${r.stripe_subs.join(' ')}]`);
  console.log(`report written: ${out}  (READ-ONLY run; no Stripe/Clerk writes possible)`);
}
main().catch(e => { console.error(e); process.exit(1); });
