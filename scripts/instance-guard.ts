// Production tools must know WHICH Clerk/Stripe instance they are talking to. A sk_test_ Clerk key silently produced a
// "production reconciliation" against a development instance; this makes that mistake impossible to miss.
export type ClerkKind = 'production' | 'development' | 'unknown';
export const clerkKind = (key: string): ClerkKind => key.startsWith('sk_live_') ? 'production' : key.startsWith('sk_test_') ? 'development' : 'unknown';
export const stripeKind = (key: string): 'live' | 'test' | 'unknown' => /^(sk|rk)_live_/.test(key) ? 'live' : /^(sk|rk)_test_/.test(key) ? 'test' : 'unknown';

/** Throws (caller exits 2) unless Stripe is LIVE and Clerk is PRODUCTION; --allow-dev-clerk downgrades the Clerk check to a loud banner. */
export function assertProductionInstances(stripeKey: string, clerkKey: string, argv: string[] = process.argv): { stripe: string; clerk: ClerkKind; banner: string } {
  const s = stripeKind(stripeKey), c = clerkKind(clerkKey), allowDev = argv.includes('--allow-dev-clerk');
  if (s !== 'live') throw new Error(`Refusing: Stripe key is ${s}; this is a PRODUCTION tool (needs sk_live_/rk_live_).`);
  if (c === 'unknown') throw new Error('Refusing: Clerk key prefix not recognised (expected sk_live_ or sk_test_).');
  if (c === 'development' && !allowDev)
    throw new Error('Refusing: CLERK_SECRET_KEY is a DEVELOPMENT instance (sk_test_). Results would not describe production Clerk. Pass --allow-dev-clerk ONLY to deliberately inspect the dev instance.');
  const banner = `INSTANCES: stripe=${s} clerk=${c}${c === 'development' ? '  ⚠ DEVELOPMENT CLERK — NOT PRODUCTION EVIDENCE' : ''}`;
  return { stripe: s, clerk: c, banner };
}
