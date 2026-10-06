/**
 * Controlled production repair of stale paid access on CANCELED subscriptions (allowlisted, canary-first, Clerk-only writes).
 * Default is DRY RUN. Needs a LIVE Stripe key (READ-ONLY restricted rk_live_ is enough — this tool never writes Stripe) and the PRODUCTION Clerk key.
 *
 *   STRIPE_SECRET_KEY=rk_live_… CLERK_SECRET_KEY=sk_live_… npx vite-node scripts/repair-stale-cancellations.ts --allowlist allow.json --canary sub_FULLID
 *   … add  --apply --canary-only --confirm "REPAIR 5 STALE CANCELLATIONS"   (repairs only the canary, then stops)
 *   … then --apply --confirm "REPAIR 5 STALE CANCELLATIONS"                   (canary already correct → processes the other four sequentially)
 *
 * allow.json = ["sub_…", …] — FULL ids, exactly 5. Receipts/snapshot go to --out-dir (default ./repair-receipts) as read-only files (never overwritten).
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertProductionInstances } from './instance-guard';
import { runRepair } from './repair-stale-cancellations-core';

const argv = process.argv; const arg = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
async function main() {
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  if (!sk || !ck) { console.error('Set STRIPE_SECRET_KEY (rk_live_/sk_live_) and CLERK_SECRET_KEY (sk_live_)'); process.exit(2); }
  if (argv.includes('--allow-dev-clerk')) { console.error('Refusing: --allow-dev-clerk is not permitted for a repair tool.'); process.exit(2); }
  let inst; try { inst = assertProductionInstances(sk, ck, argv); } catch (e: any) { console.error(e.message); process.exit(2); }
  if (!/^(rk|sk)_live_/.test(sk) || !ck.startsWith('sk_live_')) { console.error('Refusing: need rk_live_/sk_live_ Stripe and sk_live_ Clerk.'); process.exit(2); }
  console.log(inst.banner);
  const af = arg('--allowlist'), canary = arg('--canary');
  if (!af || !canary) { console.error('--allowlist <file.json> and --canary <full sub id> are required'); process.exit(2); }
  const parsed = JSON.parse(readFileSync(af, 'utf8')); const allowlist: string[] = Array.isArray(parsed) ? parsed : parsed.subscriptions;
  const apply = argv.includes('--apply'); const canaryOnly = argv.includes('--canary-only');
  const phrase = `REPAIR ${allowlist.length} STALE CANCELLATIONS`;
  if (apply && arg('--confirm') !== phrase) { console.error(`--apply requires --confirm "${phrase}"`); process.exit(2); }
  const dir = arg('--out-dir') || 'repair-receipts'; mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sink = { write: (name: string, body: unknown) => {
    const p = join(dir, `${stamp}-${name}.json`); const text = JSON.stringify({ instances: { stripe: inst!.stripe, clerk: inst!.clerk }, ...(body as object) }, null, 2);
    writeFileSync(p, text, { flag: 'wx', mode: 0o444 }); try { chmodSync(p, 0o444); } catch {}
    console.log(`wrote ${p}  sha256=${createHash('sha256').update(text).digest('hex')}`);
  } };
  const stripe = new Stripe(sk, { apiVersion: '2023-10-16' as any }); const clerk = createClerkClient({ secretKey: ck });
  console.log(apply ? `MODE: APPLY${canaryOnly ? ' (canary only)' : ''}` : 'MODE: DRY RUN (no writes)');
  const rc = await runRepair({ stripe, clerk, allowlist, canary, apply, canaryOnly, sink });
  for (const r of rc.results) console.log(`${r.outcome.padEnd(15)} ${r.sub}${r.is_canary ? ' [canary]' : ''} user=${r.clerk_user_id ?? '-'} ${r.before ? `${r.before.tier}/${r.before.billing_status}` : ''}${r.after ? ` → ${r.after.tier}/${r.after.billing_status}` : ''}${r.reason ? `  (${r.reason})` : ''}`);
  console.log(`STATUS ${rc.status}\n${rc.next_step}`);
  process.exit(rc.status.startsWith('ABORTED') ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
