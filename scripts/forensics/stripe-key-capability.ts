/**
 * READ-ONLY. Proves what the DEPLOYED PermitMap STRIPE_SECRET_KEY can read (specifically invoices.list, needed by the renewal-conversion fix).
 * Pull the Vercel *Production* STRIPE_SECRET_KEY locally (e.g. `vercel env pull`), never paste it anywhere, then:
 *   STRIPE_SECRET_KEY=… npx vite-node scripts/forensics/stripe-key-capability.ts
 * Prints only the key's SHAPE (prefix class) and per-probe OK / PERMISSION_DENIED. Write permissions (subscription/customer updates used by
 * the trial interlock and mapping stamps) are intentionally NOT probed — that would require a write.
 */
import Stripe from 'stripe';
import { readOnly } from '../readonly-guard';
import { runProbes, keyShape, PROBES } from './stripe-key-capability-core';

async function main() {
  const k = process.env.STRIPE_SECRET_KEY || '';
  if (!k) { console.error('Set STRIPE_SECRET_KEY to the deployed Production key'); process.exit(2); }
  const shape = keyShape(k); console.log(`key shape: ${shape}`);
  if (shape.startsWith('TEST') || shape === 'unrecognised') { console.error('Refusing: not a live key.'); process.exit(2); }
  const res = await runProbes(readOnly('stripe', new Stripe(k, { apiVersion: '2023-10-16' as any })));
  for (const r of res) console.log(`${r.status.padEnd(18)} ${r.probe}${r.detail ? '  — ' + r.detail : ''}  [needs: ${PROBES.find(p => p.probe === r.probe)!.needs}]`);
  const inv = res.find(r => r.probe === 'invoices.list')!;
  console.log(inv.status === 'OK' ? 'GATE: deployed key CAN read invoices — renewal-conversion classification will work.' : 'GATE: FAILED — grant Invoices: Read (or use an unrestricted key) before merging fix/renewal-conversion.');
  process.exit(res.every(r => r.status === 'OK') ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
