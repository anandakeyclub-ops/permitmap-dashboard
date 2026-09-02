// Clerk dev→prod migration MANIFEST contract (pure, no SDK, no network).
// The manifest is the single source of truth for the eventual cutover: it maps each existing dev
// Clerk user to its future production user id and carries the app-critical metadata + Stripe linkage
// needed to re-point Stripe and re-provision entitlement. This module only PARSES/VALIDATES it — it
// never creates users or mutates Stripe. See stripe-relink.ts / clerk-import.ts for (dry-run-default)
// executors and README.md for the cutover/rollback sequence.

export type MigrationStatus =
  | 'PENDING'
  | 'CREATED_IN_PROD'
  | 'STRIPE_RELINKED'
  | 'VERIFIED'
  | 'FAILED';

export const MIGRATION_STATUSES: readonly MigrationStatus[] = [
  'PENDING', 'CREATED_IN_PROD', 'STRIPE_RELINKED', 'VERIFIED', 'FAILED',
] as const;

export interface MigrationRow {
  old_dev_user_id: string;
  new_prod_user_id: string | null;
  primary_email: string;
  email_verified?: string | null;
  password_enabled?: boolean;
  two_factor_enabled?: boolean;
  external_accounts?: string[];
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  billing_status?: string | null;
  tier?: string | null;
  // App-critical metadata preserved verbatim (no key normalization; the app reads several county-key
  // variants — counties_allowed / allowed_counties / selected_counties — so ALL are kept as-is).
  public_metadata: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
  migration_status: MigrationStatus;
}

export interface ParseResult {
  rows: MigrationRow[];
  errors: string[];
}

/** A row represents a billing/entitlement user if it carries any Stripe/billing linkage. Those rows
 *  MUST be re-linked (Stripe) and re-provisioned (Clerk) or a paying/trial customer breaks. */
export function isBillingRow(r: MigrationRow): boolean {
  return !!(r.stripe_customer_id || r.stripe_subscription_id || r.billing_status || r.tier);
}

/** Parse a raw manifest object → validated rows + structural errors. Never throws. */
export function parseManifest(raw: unknown): ParseResult {
  const errors: string[] = [];
  const rows: MigrationRow[] = [];
  const container = (raw && typeof raw === 'object' && 'rows' in (raw as any))
    ? (raw as any).rows : raw;
  if (!Array.isArray(container)) {
    return { rows: [], errors: ['manifest.rows is not an array'] };
  }
  const seen = new Set<string>();
  container.forEach((r: any, i: number) => {
    if (!r || typeof r !== 'object') { errors.push(`row ${i}: not an object`); return; }
    if (!r.old_dev_user_id || typeof r.old_dev_user_id !== 'string')
      errors.push(`row ${i}: missing old_dev_user_id`);
    if (!r.primary_email || typeof r.primary_email !== 'string')
      errors.push(`row ${i}: missing primary_email`);
    if (r.public_metadata != null && typeof r.public_metadata !== 'object')
      errors.push(`row ${i}: public_metadata must be an object`);
    if (r.migration_status && !MIGRATION_STATUSES.includes(r.migration_status))
      errors.push(`row ${i}: invalid migration_status ${r.migration_status}`);
    if (r.old_dev_user_id) {
      if (seen.has(r.old_dev_user_id)) errors.push(`row ${i}: duplicate old_dev_user_id`);
      seen.add(r.old_dev_user_id);
    }
    rows.push({
      old_dev_user_id: String(r.old_dev_user_id ?? ''),
      new_prod_user_id: r.new_prod_user_id ?? null,
      primary_email: String(r.primary_email ?? ''),
      email_verified: r.email_verified ?? null,
      password_enabled: !!r.password_enabled,
      two_factor_enabled: !!r.two_factor_enabled,
      external_accounts: Array.isArray(r.external_accounts) ? r.external_accounts : [],
      stripe_customer_id: r.stripe_customer_id ?? null,
      stripe_subscription_id: r.stripe_subscription_id ?? null,
      billing_status: r.billing_status ?? null,
      tier: r.tier ?? null,
      public_metadata: (r.public_metadata && typeof r.public_metadata === 'object') ? r.public_metadata : {},
      private_metadata: (r.private_metadata && typeof r.private_metadata === 'object') ? r.private_metadata : {},
      migration_status: (r.migration_status as MigrationStatus) || 'PENDING',
    });
  });
  return { rows, errors };
}

/** Gate before any --apply step: every row must have a resolved new_prod_user_id, and every billing
 *  row must have both Stripe ids so the relink is complete. Returns the exact blocking reasons. */
export function validateForApply(rows: MigrationRow[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const r of rows) {
    if (!r.new_prod_user_id) errors.push(`${r.old_dev_user_id}: new_prod_user_id not resolved`);
    if (isBillingRow(r)) {
      if (!r.stripe_customer_id) errors.push(`${r.old_dev_user_id}: billing row missing stripe_customer_id`);
      if (!r.stripe_subscription_id) errors.push(`${r.old_dev_user_id}: billing row missing stripe_subscription_id`);
    }
  }
  return { ok: errors.length === 0, errors };
}
