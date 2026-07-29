import { SignUp } from '@clerk/nextjs';
import {
  readIntent, buildResumeUrl, buildAuthUrl, DASHBOARD_PATH,
} from '../../../lib/checkout-intent';

// Preserves a paid-plan checkout intent through Clerk sign-up.
//
// - Paid CTA (…/sign-up?plan=team&source=…): after account creation Clerk redirects to
//   the controlled first-party resume route (/checkout/resume?plan=team…), which resumes
//   checkout — the plan and attribution are NOT dropped.
// - Generic sign-up (no valid plan): redirects to /dashboard and receives the existing
//   unpaid Preview entitlement (no paid tier assigned, no Checkout Session created).
//
// `?county=` is still attached as unsafeMetadata (promoted to publicMetadata on first
// authenticated load). The redirect target is always a relative path we build ourselves
// from allowlisted, validated fields — never a caller-supplied URL (no open redirect).
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { plan, params } = readIntent(sp);

  // Paid intent → FORCE the resume route (overrides any dashboard default). No plan →
  // FALLBACK to /dashboard (still honors a Clerk redirect_url deep-link if present).
  const redirectProps = plan
    ? { forceRedirectUrl: buildResumeUrl(plan, params) }
    : { fallbackRedirectUrl: DASHBOARD_PATH };
  const signInUrl = buildAuthUrl('/sign-in', plan, params);
  const county = typeof sp.county === 'string' ? sp.county : undefined;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f1e',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <SignUp
        unsafeMetadata={county ? { county } : undefined}
        signInUrl={signInUrl}
        {...redirectProps}
      />
    </div>
  );
}
