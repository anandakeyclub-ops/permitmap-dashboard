import { SignIn } from '@clerk/nextjs';
import {
  readIntent, buildResumeUrl, buildAuthUrl, DASHBOARD_PATH,
} from '../../../lib/checkout-intent';

// Mirrors the sign-up intent handling so a returning user who clicks a paid-plan CTA
// (or is bounced here from /checkout/resume while signed out) resumes checkout after
// signing in. Generic sign-in with no valid plan lands on /dashboard.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { plan, params } = readIntent(sp);

  // Paid intent → FORCE the resume route. No plan → FALLBACK to /dashboard while still
  // honoring a Clerk redirect_url deep-link (e.g. bounced from a protected page).
  const redirectProps = plan
    ? { forceRedirectUrl: buildResumeUrl(plan, params) }
    : { fallbackRedirectUrl: DASHBOARD_PATH };
  const signUpUrl = buildAuthUrl('/sign-up', plan, params);

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f1e',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <SignIn
        signUpUrl={signUpUrl}
        {...redirectProps}
      />
    </div>
  );
}
