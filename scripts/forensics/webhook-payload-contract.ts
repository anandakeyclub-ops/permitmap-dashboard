/**
 * READ-ONLY. Pulls recent real events of the handled types from LIVE Stripe (Events: Read needed) and verifies the production handler
 * acts on each one, grouped by the API version the payload was rendered with. Zero writes (Stripe writes blocked, Clerk is an overlay).
 *   STRIPE_SECRET_KEY=rk_live_… npx vite-node scripts/forensics/webhook-payload-contract.ts [--out webhook-contract.json]
 * No Clerk key is needed: Clerk is a synthetic in-memory overlay that auto-creates a user for each identity the handler resolves (recorded in
 * resolved_clerk_users). A successful row therefore legitimately shows would_write_clerk >= 1; those are SIMULATED writes against the overlay only,
 * and nothing is written to Clerk or Stripe. What matters is the verdict: the handler looked up the right subscription, raised no
 * unknown_price / error alerts.
 */
import Stripe from 'stripe';
import { writeFileSync } from 'node:fs';
import { readOnly } from '../readonly-guard';
import { stripeKind } from '../instance-guard';
import { checkEventContract, summarize, type ContractRow } from './webhook-payload-contract-core';

const TYPES = ['checkout.session.completed', 'invoice.payment_succeeded', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
async function main() {
  const sk = process.env.STRIPE_SECRET_KEY || '';
  if (stripeKind(sk) !== 'live') { console.error('Refusing: need a LIVE Stripe key (rk_live_/sk_live_) — real payload versions only exist there.'); process.exit(2); }
  const stripe: any = readOnly('stripe', new Stripe(sk, { apiVersion: '2023-10-16' as any }));
  const rows: ContractRow[] = [];
  for (const type of TYPES) {
    let n = 0;
    for await (const ev of stripe.events.list({ type, limit: 100 })) {
      if (++n > 25) break; // newest 25 per type is plenty
      const r = await checkEventContract(ev, { stripeRead: stripe, clerkUsers: new Map() }).catch((e: any) => ({ event_id: ev.id, type, api_version: ev.api_version ?? null, verdict: 'INCONCLUSIVE', expected_sub: null, retrieved_subs: [], alerts: [], would_write_clerk: 0, would_write_stripe: [], note: String(e?.message || e).slice(0, 120) }) as ContractRow);
      rows.push(r);
    }
  }
  const summary = summarize(rows);
  writeFileSync(arg('--out') || 'webhook-contract.json', JSON.stringify({ stripe: 'live', generated_at: new Date().toISOString(), summary, rows }, null, 2));
  console.log('SUMMARY', JSON.stringify(summary));
  for (const r of rows.filter(r => r.verdict.startsWith('FAIL') || r.verdict === 'INCONCLUSIVE')) console.log(`${r.verdict} ${r.type} ${r.event_id} api=${r.api_version} sub=${r.expected_sub} alerts=${r.alerts.join(',')} ${r.note ?? ''}`);
  console.log('Events are retained ~30 days; types with zero events in the window are listed as absent, not passed.');
}
main().catch(e => { console.error(e); process.exit(1); });
