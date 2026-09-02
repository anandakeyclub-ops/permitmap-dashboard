// Clerk PRODUCTION user-import tooling (dependency-injected, DRY-RUN BY DEFAULT, FAIL-CLOSED).
// Creates each dev user in the production Clerk instance preserving the primary (verified) email and
// ALL app-critical public_metadata verbatim. It NEVER runs unless production credentials are present
// AND apply:true is passed. Password hashes and OAuth identities CANNOT be transferred dev→prod via
// the API (Clerk does not expose source hashes / OAuth tokens) — those users re-establish auth on prod
// (password reset / OAuth reconnect); their verified email + metadata still migrate.

import { MigrationRow } from './manifest';
import { checkMetadataPreserved } from './preserve';

export interface ClerkLike {
  users: {
    createUser: (p: {
      emailAddress: string[];
      publicMetadata: Record<string, unknown>;
      privateMetadata?: Record<string, unknown>;
      skipPasswordRequirement?: boolean;
    }) => Promise<{ id: string; publicMetadata?: Record<string, unknown> }>;
  };
}

export interface ImportPlanItem {
  old_dev_user_id: string;
  primary_email: string;
  will_create: boolean;
  auth_note: string;   // how the user will re-authenticate on prod (password reset / oauth reconnect / email code)
  metadata_keys: string[];
}

function authNote(r: MigrationRow): string {
  if (r.external_accounts && r.external_accounts.length)
    return `OAuth reconnect required (${r.external_accounts.join(',')})`;
  if (r.password_enabled) return 'Password reset required (hash not transferable)';
  return 'Passwordless (email code) — works on prod with verified email';
}

/** PURE: what would be created, and how each user re-authenticates. No creds, no writes. */
export function planClerkImport(rows: MigrationRow[]): ImportPlanItem[] {
  return rows.map((r) => ({
    old_dev_user_id: r.old_dev_user_id,
    primary_email: r.primary_email,
    will_create: !r.new_prod_user_id,
    auth_note: authNote(r),
    metadata_keys: Object.keys(r.public_metadata || {}),
  }));
}

export interface ImportResult {
  ok: boolean;
  reason?: string;
  dryRun: boolean;
  created: number;
  mapped: Array<{ old_dev_user_id: string; new_prod_user_id: string }>;
  errors: string[];
}

/** Execute the import. FAIL-CLOSED: if prodCredentialsPresent is false OR no clerk client is injected,
 *  performs NO production operation and returns ok:false. DEFAULT dry-run (created:0, zero writes). */
export async function runClerkImport(
  rows: MigrationRow[],
  opts: { apply?: boolean; prodCredentialsPresent?: boolean; clerk?: ClerkLike } = {},
): Promise<ImportResult> {
  if (!opts.prodCredentialsPresent || !opts.clerk) {
    return { ok: false, reason: 'NO_PROD_CREDENTIALS', dryRun: true, created: 0, mapped: [], errors: [] };
  }
  if (opts.apply !== true) {
    return { ok: true, dryRun: true, created: 0, mapped: [], errors: [] };
  }
  const mapped: Array<{ old_dev_user_id: string; new_prod_user_id: string }> = [];
  const errors: string[] = [];
  let created = 0;
  for (const r of rows) {
    if (r.new_prod_user_id) continue; // already created (resumable)
    try {
      const u = await opts.clerk.users.createUser({
        emailAddress: [r.primary_email],
        publicMetadata: r.public_metadata,
        skipPasswordRequirement: true,
      });
      const pres = checkMetadataPreserved(r.public_metadata, u.publicMetadata || {});
      if (!pres.preserved) {
        errors.push(`${r.old_dev_user_id}: metadata not preserved (missing=${pres.missingKeys} coerced=${pres.coercedKeys})`);
      }
      mapped.push({ old_dev_user_id: r.old_dev_user_id, new_prod_user_id: u.id });
      created++;
    } catch (e) {
      errors.push(`${r.old_dev_user_id}: ${String(e).slice(0, 160)}`);
    }
  }
  return { ok: errors.length === 0, dryRun: false, created, mapped, errors };
}
