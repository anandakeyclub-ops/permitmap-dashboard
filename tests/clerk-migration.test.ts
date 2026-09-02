import { describe, it, expect, vi } from 'vitest';
import { parseManifest, validateForApply, isBillingRow, MigrationRow } from '../scripts/migrations/manifest';
import { deepEqualStrict, checkMetadataPreserved } from '../scripts/migrations/preserve';
import { planStripeRelink, runStripeRelink, StripeLike } from '../scripts/migrations/stripe-relink';
import { planClerkImport, runClerkImport, ClerkLike } from '../scripts/migrations/clerk-import';
import { buildRollbackManifest } from '../scripts/migrations/rollback';

// Synthetic fixture mirroring the REAL metadata schema (arrays, booleans, the several county-key
// variants) — NO real PII.
const billingRow = (over: Partial<MigrationRow> = {}): MigrationRow => ({
  old_dev_user_id: 'user_dev_1', new_prod_user_id: null, primary_email: 'a@example.com',
  email_verified: 'verified', password_enabled: true, two_factor_enabled: false, external_accounts: [],
  stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', billing_status: 'active', tier: 'pro',
  public_metadata: {
    tier: 'pro', billing_status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
    counties_allowed: ['lee', 'collier'], allowed_counties: ['lee'], selected_counties: ['lee', 'collier'],
    selected_trades: ['hvac'], onboarding_complete: true, onboarding_state: 'done', firstLogin: false,
  },
  private_metadata: {}, migration_status: 'PENDING', ...over,
});

describe('manifest parsing', () => {
  it('parses valid rows and reports structural errors', () => {
    const { rows, errors } = parseManifest({ rows: [
      billingRow(), { old_dev_user_id: 'user_dev_1', primary_email: '' }, // dup id + missing email
      { primary_email: 'x@y.com', migration_status: 'BOGUS' },            // missing id + bad status
    ]});
    expect(rows.length).toBe(3);
    expect(errors.some((e) => e.includes('duplicate old_dev_user_id'))).toBe(true);
    expect(errors.some((e) => e.includes('missing primary_email'))).toBe(true);
    expect(errors.some((e) => e.includes('missing old_dev_user_id'))).toBe(true);
    expect(errors.some((e) => e.includes('invalid migration_status'))).toBe(true);
  });
  it('non-array manifest fails cleanly', () => {
    expect(parseManifest({ rows: 'nope' }).errors[0]).toMatch(/not an array/);
  });
  it('isBillingRow flags Stripe/entitlement users', () => {
    expect(isBillingRow(billingRow())).toBe(true);
    expect(isBillingRow(billingRow({ stripe_customer_id: null, stripe_subscription_id: null,
      billing_status: null, tier: null }))).toBe(false);
  });
});

describe('metadata preservation (no drop / no coercion)', () => {
  it('deepEqualStrict keeps arrays + booleans typed', () => {
    expect(deepEqualStrict(['lee'], ['lee'])).toBe(true);
    expect(deepEqualStrict(true, 'true')).toBe(false);         // boolean not stringified
    expect(deepEqualStrict(['lee'], 'lee')).toBe(false);        // array not flattened to string
    expect(deepEqualStrict(['lee', 'collier'], ['collier', 'lee'])).toBe(false); // order matters
  });
  it('round-trip preserves every key/type', () => {
    const src = billingRow().public_metadata;
    const good = checkMetadataPreserved(src, JSON.parse(JSON.stringify(src)));
    expect(good.preserved).toBe(true);
    const coerced = { ...src, onboarding_complete: 'true', counties_allowed: 'lee,collier' };
    const bad = checkMetadataPreserved(src, coerced as any);
    expect(bad.preserved).toBe(false);
    expect(bad.coercedKeys).toEqual(expect.arrayContaining(['onboarding_complete', 'counties_allowed']));
  });
  it('detects dropped keys', () => {
    const src = billingRow().public_metadata;
    const dropped = { ...src }; delete (dropped as any).selected_trades;
    expect(checkMetadataPreserved(src, dropped).missingKeys).toContain('selected_trades');
  });
});

describe('validateForApply gate (incomplete mapping blocks apply)', () => {
  it('blocks when new_prod_user_id unresolved', () => {
    const v = validateForApply([billingRow()]);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('new_prod_user_id not resolved'))).toBe(true);
  });
  it('blocks billing row missing Stripe ids even when mapped', () => {
    const v = validateForApply([billingRow({ new_prod_user_id: 'user_prod_1', stripe_subscription_id: null })]);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('missing stripe_subscription_id'))).toBe(true);
  });
  it('passes when fully mapped', () => {
    expect(validateForApply([billingRow({ new_prod_user_id: 'user_prod_1' })]).ok).toBe(true);
  });
});

describe('Stripe relink planning + dry-run zero-writes', () => {
  const rows = [billingRow({ new_prod_user_id: 'user_prod_1' })];
  it('plans customer + subscription clerk_user_id old→new', () => {
    const plan = planStripeRelink(rows);
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'customer.metadata.clerk_user_id', old_value: 'user_dev_1', new_value: 'user_prod_1', customer_id: 'cus_1' }),
      expect.objectContaining({ target: 'subscription.metadata.clerk_user_id', old_value: 'user_dev_1', new_value: 'user_prod_1', subscription_id: 'sub_1' }),
    ]));
  });
  it('DEFAULT dry-run performs ZERO Stripe writes', async () => {
    const stripe: StripeLike = {
      customers: { update: vi.fn() }, subscriptions: { update: vi.fn() },
    };
    const res = await runStripeRelink(rows, { stripe }); // no apply flag → dry-run
    expect(res.dryRun).toBe(true);
    expect(res.applied).toBe(0);
    expect(stripe.customers.update).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });
  it('apply:true writes exactly the planned mutations', async () => {
    const stripe: StripeLike = {
      customers: { update: vi.fn().mockResolvedValue({}) },
      subscriptions: { update: vi.fn().mockResolvedValue({}) },
    };
    const res = await runStripeRelink(rows, { apply: true, stripe });
    expect(res.dryRun).toBe(false);
    expect(res.applied).toBe(2);
    expect(stripe.customers.update).toHaveBeenCalledWith('cus_1', { metadata: { clerk_user_id: 'user_prod_1' } });
    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { metadata: { clerk_user_id: 'user_prod_1' } });
  });
});

describe('Clerk import: fail-closed + mapping + preservation', () => {
  it('fails closed with no prod credentials (zero writes)', async () => {
    const clerk: ClerkLike = { users: { createUser: vi.fn() } };
    const res = await runClerkImport([billingRow()], { apply: true, prodCredentialsPresent: false, clerk });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('NO_PROD_CREDENTIALS');
    expect(res.created).toBe(0);
    expect(clerk.users.createUser).not.toHaveBeenCalled();
  });
  it('default dry-run creates nothing even with creds present', async () => {
    const clerk: ClerkLike = { users: { createUser: vi.fn() } };
    const res = await runClerkImport([billingRow()], { prodCredentialsPresent: true, clerk });
    expect(res.dryRun).toBe(true);
    expect(res.created).toBe(0);
    expect(clerk.users.createUser).not.toHaveBeenCalled();
  });
  it('apply creates prod users, maps old→new, preserves metadata', async () => {
    const src = billingRow();
    const clerk: ClerkLike = { users: {
      createUser: vi.fn().mockImplementation(async (p) => ({ id: 'user_prod_1', publicMetadata: p.publicMetadata })),
    }};
    const res = await runClerkImport([src], { apply: true, prodCredentialsPresent: true, clerk });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(1);
    expect(res.mapped).toEqual([{ old_dev_user_id: 'user_dev_1', new_prod_user_id: 'user_prod_1' }]);
    expect(res.errors).toEqual([]); // metadata preserved (createUser echoed publicMetadata)
  });
  it('plan surfaces auth re-establishment (password reset / oauth reconnect)', () => {
    const plan = planClerkImport([
      billingRow({ old_dev_user_id: 'pw', password_enabled: true, external_accounts: [] }),
      billingRow({ old_dev_user_id: 'oauth', password_enabled: false, external_accounts: ['oauth_google'] }),
      billingRow({ old_dev_user_id: 'passwordless', password_enabled: false, external_accounts: [] }),
    ]);
    expect(plan.find((p) => p.old_dev_user_id === 'pw')!.auth_note).toMatch(/Password reset/);
    expect(plan.find((p) => p.old_dev_user_id === 'oauth')!.auth_note).toMatch(/OAuth reconnect/);
    expect(plan.find((p) => p.old_dev_user_id === 'passwordless')!.auth_note).toMatch(/email code/);
  });
});

describe('rollback manifest', () => {
  it('reverses Stripe relink (restore dev id) + lists operational steps', () => {
    const rb = buildRollbackManifest([billingRow({ new_prod_user_id: 'user_prod_1' })]);
    expect(rb.stripe_restore).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'customer.metadata.clerk_user_id', old_value: 'user_prod_1', new_value: 'user_dev_1' }),
    ]));
    expect(rb.operational_steps.join(' ')).toMatch(/Restore Vercel Production env/);
  });
});
