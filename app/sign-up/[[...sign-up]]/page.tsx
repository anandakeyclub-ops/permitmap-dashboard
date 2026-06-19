import { SignUp } from '@clerk/nextjs';

// Reads ?county=<slug> from the marketing funnel and attaches it as unsafeMetadata
// on the new user. A server action later promotes it to publicMetadata (PART A).
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ county?: string }>;
}) {
  const { county } = await searchParams;
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f1e',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <SignUp unsafeMetadata={county ? { county } : undefined} />
    </div>
  );
}
