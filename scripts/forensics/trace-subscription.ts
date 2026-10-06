/**
 * READ-ONLY forensic trace of one Stripe subscription that no production Clerk user claims.
 *   STRIPE_SECRET_KEY=rk_live_… CLERK_SECRET_KEY=sk_live_… npx vite-node scripts/forensics/trace-subscription.ts sub_xxx [--out trace.json] [--drift sub_a,sub_b]
 * Both SDK clients are read-only guarded. Emails are MASKED in all output (a***@domain); full values are used in memory only.
 * --drift prints Stripe state vs the bound Clerk user for canceled-but-still-paid cases (separate concern; no writes).
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { writeFileSync } from 'node:fs';
import { readOnly } from '../readonly-guard';
import { assertProductionInstances } from '../instance-guard';
import { tierForSubscription } from '../../lib/provisioning';
import { classifyOrphan, OrphanEvidence } from './orphan-classify';

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const mask = (e?: string | null) => (e ? `${e[0]}***@${e.split('@')[1] ?? '?'}` : null);
const iso = (t?: number | null) => (t ? new Date(t * 1000).toISOString() : null);
const id = (x: any) => (typeof x === 'string' ? x : x?.id);

async function main() {
  const subId = process.argv[2];
  if (!subId?.startsWith('sub_')) { console.error('usage: trace-subscription.ts sub_xxx [--out f] [--drift sub_a,sub_b]'); process.exit(2); }
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  if (!sk || !ck) { console.error('Set STRIPE_SECRET_KEY and CLERK_SECRET_KEY'); process.exit(2); }
  let inst: ReturnType<typeof assertProductionInstances>;
  try { inst = assertProductionInstances(sk, ck); } catch (e: any) { console.error(e.message); process.exit(2); }
  console.log(inst.banner);
  const stripe: any = readOnly('stripe', new Stripe(sk, { apiVersion: '2023-10-16' as any }));
  const clerk: any = readOnly('clerk', createClerkClient({ secretKey: ck }));

  const users: any[] = [];
  for (let o = 0; ; o += 500) { const p: any = await clerk.users.getUserList({ limit: 500, offset: o }); const r = Array.isArray(p) ? p : p.data; users.push(...r); if (r.length < 500) break; }
  const prodUsers = users.map(u => ({
    id: u.id, created_at: u.createdAt, emails: (u.emailAddresses || []).map((e: any) => e.emailAddress as string),
    tier: u.publicMetadata?.tier ?? null, billing: u.publicMetadata?.billing_status ?? null,
    bound_sub: u.publicMetadata?.stripe_subscription_id ?? null, bound_customer: u.publicMetadata?.stripe_customer_id ?? null,
    last_sign_in_at: u.lastSignInAt ?? null,
  }));

  const sub: any = await stripe.subscriptions.retrieve(subId);
  const custId = id(sub.customer); const cust: any = await stripe.customers.retrieve(custId);
  const sessions: any[] = []; for await (const s of stripe.checkout.sessions.list({ subscription: subId, limit: 20 })) sessions.push(s);
  if (!sessions.length) for await (const s of stripe.checkout.sessions.list({ customer: custId, limit: 20 })) sessions.push(s);
  const invoices: any[] = []; for await (const i of stripe.invoices.list({ subscription: subId, limit: 20 })) invoices.push(i);
  const sameEmail: string[] = [];
  if (cust.email) for await (const c of stripe.customers.list({ email: cust.email, limit: 20 })) if (c.id !== custId) sameEmail.push(c.id);
  const otherSubs: any[] = []; for await (const s of stripe.subscriptions.list({ customer: custId, status: 'all', limit: 20 })) if (s.id !== subId) otherSubs.push(s);

  const evidence: OrphanEvidence = {
    sub: { id: sub.id, status: sub.status, created: sub.created, trial_end: sub.trial_end ?? null, cancel_at_period_end: !!sub.cancel_at_period_end, cancel_at: sub.cancel_at ?? null, customer: custId, clerk_user_id: sub.metadata?.clerk_user_id ?? null, tier: tierForSubscription(sub) },
    customer: { id: custId, created: cust.created, email: cust.email ?? null, clerk_user_id: cust.metadata?.clerk_user_id ?? null },
    sessions: sessions.map(s => ({ id: s.id, created: s.created, client_reference_id: s.client_reference_id ?? null, meta_clerk_user_id: s.metadata?.clerk_user_id ?? null, email: s.customer_details?.email ?? s.customer_email ?? null })),
    prodUsers, otherCustomersSameEmail: sameEmail, otherSubsOnCustomer: otherSubs.map(s => ({ id: s.id, status: s.status })),
  };
  const finding = classifyOrphan(evidence);

  // Weak timing evidence (explicitly NOT proof): prod users created within 48h of the checkout/subscription.
  const anchor = (sessions[0]?.created ?? sub.created) * 1000;
  const nearby = prodUsers.filter(u => Math.abs(u.created_at - anchor) < 48 * 3600e3).map(u => ({ id: u.id, hours_from_checkout: +((u.created_at - anchor) / 3600e3).toFixed(1), bound_sub: u.bound_sub, tier: u.tier }));

  const report: any = {
    instances: { stripe: inst.stripe, clerk: inst.clerk }, generated_at: new Date().toISOString(), subscription: {
      id: sub.id, status: sub.status, tier: evidence.sub.tier, created: iso(sub.created), trial_start: iso(sub.trial_start), trial_end: iso(sub.trial_end),
      cancel_at_period_end: !!sub.cancel_at_period_end, cancel_at: iso(sub.cancel_at), canceled_at: iso(sub.canceled_at), ended_at: iso(sub.ended_at),
      current_period_end: iso(sub.current_period_end), collection_method: sub.collection_method, has_default_pm: !!(sub.default_payment_method || cust.invoice_settings?.default_payment_method),
      metadata_keys: Object.keys(sub.metadata || {}), metadata_clerk_user_id: sub.metadata?.clerk_user_id ?? null, plan_metadata: sub.metadata?.plan ?? null,
      price_ids: (sub.items?.data || []).map((i: any) => i.price?.id),
    },
    customer: { id: custId, created: iso(cust.created), email_masked: mask(cust.email), metadata_keys: Object.keys(cust.metadata || {}), metadata_clerk_user_id: cust.metadata?.clerk_user_id ?? null },
    checkout_sessions: sessions.map(s => ({ id: s.id, created: iso(s.created), status: s.status, payment_status: s.payment_status, mode: s.mode, client_reference_id: s.client_reference_id ?? null, metadata_clerk_user_id: s.metadata?.clerk_user_id ?? null, email_masked: mask(s.customer_details?.email ?? s.customer_email), utm_or_plan_meta: Object.fromEntries(Object.entries(s.metadata || {}).filter(([k]) => k !== 'clerk_user_id')) })),
    invoices: invoices.map(i => ({ id: i.id, created: iso(i.created), status: i.status, billing_reason: i.billing_reason, amount_paid: i.amount_paid })),
    other_customers_same_email: sameEmail, other_subs_on_customer: evidence.otherSubsOnCustomer,
    clerk_email_matches: prodUsers.filter(u => cust.email && u.emails.map(e => e.toLowerCase()).includes(String(cust.email).toLowerCase())).map(u => ({ id: u.id, created_at: iso(u.created_at), tier: u.tier, billing: u.billing, bound_sub: u.bound_sub, bound_customer: u.bound_customer, last_sign_in_at: iso(u.last_sign_in_at) })),
    clerk_users_bound_to_this_customer: prodUsers.filter(u => u.bound_customer === custId).map(u => u.id),
    clerk_users_created_within_48h_of_checkout_WEAK_EVIDENCE: nearby,
    finding,
  };

  if (arg('--drift')) {
    report.drift = [];
    for (const sid of arg('--drift')!.split(',').filter(Boolean)) {
      const s: any = await stripe.subscriptions.retrieve(sid);
      const bound = prodUsers.filter(u => u.bound_sub === sid);
      const mapped = prodUsers.filter(u => u.id === s.metadata?.clerk_user_id);
      report.drift.push({ sub: sid, stripe_status: s.status, canceled_at: iso(s.canceled_at), ended_at: iso(s.ended_at), cancellation_reason: s.cancellation_details?.reason ?? null, cancellation_feedback: s.cancellation_details?.feedback ?? null,
        tier: tierForSubscription(s), clerk_bound_users: bound.map(u => ({ id: u.id, tier: u.tier, billing: u.billing })), clerk_users_by_stripe_metadata_id: mapped.map(u => ({ id: u.id, tier: u.tier, billing: u.billing })) });
    }
  }

  writeFileSync(arg('--out') || `trace-${subId}.json`, JSON.stringify(report, null, 2));
  const S = report.subscription;
  console.log(`SUB ${S.id}: ${S.status} ${S.tier} created=${S.created} trial_end=${S.trial_end} cancel_at_period_end=${S.cancel_at_period_end} canceled_at=${S.canceled_at}`);
  console.log(`CUSTOMER ${custId}: created=${report.customer.created} email=${report.customer.email_masked} meta.clerk_user_id=${report.customer.metadata_clerk_user_id} sub.meta.clerk_user_id=${S.metadata_clerk_user_id}`);
  report.checkout_sessions.forEach((s: any) => console.log(`CHECKOUT ${s.id} ${s.created} ${s.status}/${s.payment_status} client_ref=${s.client_reference_id} meta=${s.metadata_clerk_user_id} email=${s.email_masked}`));
  report.invoices.forEach((i: any) => console.log(`INVOICE ${i.id} ${i.created} ${i.status} ${i.billing_reason} paid=${i.amount_paid}`));
  console.log(`CLERK email matches: ${JSON.stringify(report.clerk_email_matches)}  bound-to-customer: ${JSON.stringify(report.clerk_users_bound_to_this_customer)}`);
  console.log(`CLERK created within 48h (weak): ${JSON.stringify(nearby)}`);
  console.log(`FINDING: ${finding.classification} [${finding.strength}] candidate=${finding.candidate_prod_user_id}`); finding.notes.forEach(n => console.log('  note:', n)); finding.next_steps.forEach(n => console.log('  next:', n));
  (report.drift || []).forEach((d: any) => console.log(`DRIFT ${d.sub}: stripe=${d.stripe_status} ended=${d.ended_at} reason=${d.cancellation_reason} clerk_bound=${JSON.stringify(d.clerk_bound_users)} clerk_by_meta=${JSON.stringify(d.clerk_users_by_stripe_metadata_id)}`));
  console.log('READ-ONLY run. No Stripe/Clerk writes possible from this tool.');
}
main().catch(e => { console.error(e); process.exit(1); });
