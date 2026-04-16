import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { SignIn } from '@clerk/nextjs';

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect('/dashboard');

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f1e',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <div style={{ marginBottom: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.03em' }}>
          permit<span style={{ color: '#3b82f6' }}>map</span>
        </div>
        <p style={{ color: '#475569', fontSize: 15, marginTop: 8 }}>
          Construction intelligence for Florida contractors
        </p>
      </div>
      <SignIn
        appearance={{
          elements: {
            card: { background: '#111827', border: '1px solid #1e293b', borderRadius: 12 },
            headerTitle: { color: '#f1f5f9' },
            headerSubtitle: { color: '#64748b' },
            formButtonPrimary: { background: '#2563eb' },
            formFieldInput: { background: '#1e293b', borderColor: '#334155', color: '#f1f5f9' },
            formFieldLabel: { color: '#94a3b8' },
            footerActionLink: { color: '#3b82f6' },
          }
        }}
      />
    </div>
  );
}
