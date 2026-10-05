/**
 * READ-ONLY Clerk instance probe. Run it ONCE PER INSTANCE (dev key, then prod key) to compare them.
 *   CLERK_SECRET_KEY=<sk_test_… dev | sk_live_… prod> npx vite-node scripts/forensics/clerk-instance-probe.ts user_xxx [--out probe.json]
 * Prints: instance kind (from key prefix), whether the user id exists, its creation/sign-in times, masked emails, entitlement-relevant
 * metadata, and a creation-date histogram of ALL users (reveals the import moment and any account created after it).
 * Read-only guarded (getUser/getUserList only). Emails masked in all output.
 */
import { createClerkClient } from '@clerk/backend';
import { writeFileSync } from 'node:fs';
import { readOnly } from '../readonly-guard';

export function timelineSummary(createdAtMs: number[]) {
  const byDay: Record<string, number> = {};
  for (const t of createdAtMs) { const d = new Date(t).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
  const sorted = [...createdAtMs].sort((a, b) => a - b);
  return { count: sorted.length, earliest: sorted.length ? new Date(sorted[0]).toISOString() : null, latest: sorted.length ? new Date(sorted[sorted.length - 1]).toISOString() : null, by_day: Object.fromEntries(Object.entries(byDay).sort()) };
}
const mask = (e?: string | null) => (e ? `${e[0]}***@${e.split('@')[1] ?? '?'}` : null);
const iso = (t?: number | null) => (t ? new Date(t).toISOString() : null);

async function main() {
  const uid = process.argv[2]; const ck = process.env.CLERK_SECRET_KEY || '';
  if (!uid?.startsWith('user_') || !ck) { console.error('usage: CLERK_SECRET_KEY=… clerk-instance-probe.ts user_xxx [--out f]'); process.exit(2); }
  const kind = ck.startsWith('sk_live_') ? 'PRODUCTION' : ck.startsWith('sk_test_') ? 'DEVELOPMENT' : 'UNKNOWN';
  const clerk: any = readOnly('clerk', createClerkClient({ secretKey: ck }));
  const all: any[] = [];
  for (let o = 0; ; o += 500) { const p: any = await clerk.users.getUserList({ limit: 500, offset: o }); const r = Array.isArray(p) ? p : p.data; all.push(...r); if (r.length < 500) break; }
  let found: any = null; let lookupError: string | null = null;
  try { found = await clerk.users.getUser(uid); } catch (e: any) { lookupError = `${e?.status ?? ''} ${e?.errors?.[0]?.code ?? e?.message ?? e}`.trim(); }
  const pm = found?.publicMetadata || {};
  const report = {
    generated_at: new Date().toISOString(), instance_kind_from_key_prefix: kind, user_id: uid, exists: !!found, lookup_error: found ? null : lookupError,
    user: found ? { created_at: iso(found.createdAt), last_sign_in_at: iso(found.lastSignInAt), emails_masked: (found.emailAddresses || []).map((e: any) => mask(e.emailAddress)),
      tier: pm.tier ?? null, billing_status: pm.billing_status ?? null, stripe_customer_id: pm.stripe_customer_id ?? null, stripe_subscription_id: pm.stripe_subscription_id ?? null,
      onboarding_complete: pm.onboarding_complete ?? null, banned: !!found.banned } : null,
    instance_user_count: all.length, creation_timeline: timelineSummary(all.map(u => u.createdAt)),
  };
  writeFileSync(arg('--out') || `probe-${kind.toLowerCase()}.json`, JSON.stringify(report, null, 2));
  console.log(`INSTANCE (by key prefix): ${kind}   users: ${all.length}`);
  console.log(`${uid}: ${found ? 'EXISTS' : 'NOT FOUND'}${found ? '' : '  (' + lookupError + ')'}`);
  if (report.user) console.log(JSON.stringify(report.user));
  console.log('creation timeline:', JSON.stringify(report.creation_timeline));
  console.log('READ-ONLY run.');
}
function arg(n: string) { return process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined; }
if (process.argv[1] && /clerk-instance-probe/.test(process.argv[1])) main().catch(e => { console.error(e); process.exit(1); });
