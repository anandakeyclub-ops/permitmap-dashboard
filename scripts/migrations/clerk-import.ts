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

/** A prod user that WAS created but whose migration was NOT accepted (metadata verification failed).
 *  The prod user still exists in Clerk; deletion is a separate destructive step left explicit/manual. */
export interface CleanupItem {
  old_dev_user_id: string;
  new_prod_user_id: string;
  reason: string;
}

export interface ImportResult {
  ok: boolean;
  reason?: string;
  dryRun: boolean;
  created: number;                 // prod users actually created this run (includes any unverified orphan)
  mapped: Array<{ old_dev_user_id: string; new_prod_user_id: string }>; // ACCEPTED migrations only (→ CREATED_IN_PROD)
  cleanup_required: CleanupItem[]; // created-but-unverified orphans needing manual resolution (→ CREATED_UNVERIFIED)
  stoppedEarly: boolean;           // true if we halted the run before processing all rows
  errors: string[];
}

/** Execute the import. FAIL-CLOSED: if prodCredentialsPresent is false OR no clerk client is injected,
 *  performs NO production operation and returns ok:false. DEFAULT dry-run (created:0, zero writes).
 *
 *  Fail-safe semantics (apply mode):
 *   - create succeeds but metadata verification fails ⇒ HARD FAILED row: the created prod user id is
 *     recorded in cleanup_required (NOT in mapped, NOT accepted as CREATED_IN_PROD), and processing of
 *     the remaining users STOPS immediately (unexpected prod API behavior must not create the rest of
 *     the population). The orphan is never auto-deleted — cleanup is explicit/manual.
 *   - resumable: rows already carrying new_prod_user_id are skipped (no duplicate create); and a prior
 *     unresolved orphan (migration_status CREATED_UNVERIFIED) BLOCKS apply until it is resolved, so a
 *     failed/unverified user can never be silently retried as a second duplicate. */
export async function runClerkImport(
  rows: MigrationRow[],
  opts: { apply?: boolean; prodCredentialsPresent?: boolean; clerk?: ClerkLike } = {},
): Promise<ImportResult> {
  const base = { dryRun: true as boolean, created: 0, mapped: [] as ImportResult['mapped'],
    cleanup_required: [] as CleanupItem[], stoppedEarly: false, errors: [] as string[] };
  if (!opts.prodCredentialsPresent || !opts.clerk) {
    return { ...base, ok: false, reason: 'NO_PROD_CREDENTIALS' };
  }
  if (opts.apply !== true) {
    return { ...base, ok: true }; // dry-run: zero writes
  }

  // Resumability gate: never proceed while a prior run left an unresolved created-but-unverified
  // orphan. Re-running would otherwise re-create the same user (duplicate) or advance past a state
  // that still needs manual cleanup. Block until those rows are resolved.
  const unresolved = rows.filter((r) => r.migration_status === 'CREATED_UNVERIFIED');
  if (unresolved.length) {
    return {
      ...base, dryRun: false, ok: false, reason: 'CLEANUP_REQUIRED_UNRESOLVED',
      cleanup_required: unresolved.map((r) => ({
        old_dev_user_id: r.old_dev_user_id,
        new_prod_user_id: r.new_prod_user_id ?? '',
        reason: 'prior run created this prod user but metadata verification failed; resolve before re-apply',
      })),
      errors: [`${unresolved.length} row(s) in CREATED_UNVERIFIED — resolve cleanup before apply`],
    };
  }

  const mapped: ImportResult['mapped'] = [];
  const cleanup_required: CleanupItem[] = [];
  const errors: string[] = [];
  let created = 0;
  let stoppedEarly = false;
  for (const r of rows) {
    if (r.new_prod_user_id) continue; // already created/mapped (resumable) — no duplicate create
    let u: { id: string; publicMetadata?: Record<string, unknown> };
    try {
      u = await opts.clerk.users.createUser({
        emailAddress: [r.primary_email],
        publicMetadata: r.public_metadata,
        skipPasswordRequirement: true,
      });
    } catch (e) {
      // Create itself threw ⇒ no prod artifact created for this row. Record and continue.
      errors.push(`${r.old_dev_user_id}: create failed: ${String(e).slice(0, 160)}`);
      continue;
    }
    created++; // the prod user now exists, verified or not
    const pres = checkMetadataPreserved(r.public_metadata, u.publicMetadata || {});
    if (!pres.preserved) {
      // HARD FAIL: user exists but is NOT accepted. Record as cleanup-required (never mapped), then
      // STOP — do not create the remaining population if the prod API is misbehaving.
      cleanup_required.push({
        old_dev_user_id: r.old_dev_user_id,
        new_prod_user_id: u.id,
        reason: `metadata not preserved after create (missing=[${pres.missingKeys}] coerced=[${pres.coercedKeys}]) — prod user ${u.id} created but NOT accepted; delete manually or fix metadata then re-verify`,
      });
      errors.push(`${r.old_dev_user_id}: metadata verification FAILED after create (prod user ${u.id}) — HARD FAIL, halting remaining users`);
      stoppedEarly = true;
      break;
    }
    mapped.push({ old_dev_user_id: r.old_dev_user_id, new_prod_user_id: u.id });
  }
  return {
    ok: errors.length === 0 && cleanup_required.length === 0,
    dryRun: false, created, mapped, cleanup_required, stoppedEarly, errors,
  };
}
