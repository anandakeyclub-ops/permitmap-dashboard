#!/usr/bin/env node
// READ-ONLY Clerk dev-user exporter → migration manifest. Reads CLERK_SECRET_KEY from the env
// (never hardcoded, never printed) and GETs /v1/users, writing a machine-readable manifest for the
// migration. It performs NO writes to Clerk/Stripe and creates NO users. Fail-closed: no key → exit.
// The manifest contains PII (emails) — it is written OUTSIDE version control (see --out; default is a
// .local.json path that .gitignore excludes). Console output is sanitized (counts only).
//
//   CLERK_SECRET_KEY=sk_... node scripts/migrations/export-dev-users.mjs --out C:\path\manifest.json
//
// Migratability reality (Clerk API): password hashes and OAuth identities CANNOT be read from a
// source instance, so dev→prod password/OAuth do not transfer — users re-establish auth on prod
// (password reset / OAuth reconnect); verified email + all public_metadata DO migrate.
import fs from 'node:fs';

const sk = process.env.CLERK_SECRET_KEY;
if (!sk) { console.error('FAIL-CLOSED: CLERK_SECRET_KEY not set. No export performed.'); process.exit(2); }
const args = process.argv.slice(2);
const out = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : 'scripts/migrations/dev-users.local.json'; })();

async function cget(path) {
  const r = await fetch('https://api.clerk.com/v1' + path, { headers: { Authorization: 'Bearer ' + sk } });
  if (!r.ok) throw new Error(`Clerk ${path} -> ${r.status}`);
  return r.json();
}

const users = await cget('/users?limit=200&order_by=-created_at');
const rows = users.map((u) => {
  const pm = u.public_metadata || {};
  const emails = u.email_addresses || [];
  const prim = emails.find((e) => e.id === u.primary_email_address_id) || emails[0] || {};
  return {
    old_dev_user_id: u.id,
    new_prod_user_id: null,
    primary_email: prim.email_address || '',
    email_verified: (prim.verification || {}).status || null,
    password_enabled: !!u.password_enabled,
    two_factor_enabled: !!u.two_factor_enabled,
    external_accounts: (u.external_accounts || []).map((a) => a.provider),
    stripe_customer_id: pm.stripe_customer_id ?? null,
    stripe_subscription_id: pm.stripe_subscription_id ?? null,
    billing_status: pm.billing_status ?? null,
    tier: pm.tier ?? null,
    public_metadata: pm,
    private_metadata: u.private_metadata || {},
    migration_status: 'PENDING',
  };
});
fs.writeFileSync(out, JSON.stringify({ generated: 'dev-export', instance: 'development', count: rows.length, rows }, null, 2));
const billing = rows.filter((r) => r.stripe_customer_id || r.stripe_subscription_id || r.billing_status || r.tier).length;
console.log(`READ-ONLY export complete. users=${rows.length} billing=${billing} → ${out} (PII; gitignored). No writes performed.`);
