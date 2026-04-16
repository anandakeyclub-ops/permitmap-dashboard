import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f1e',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <SignIn />
    </div>
  );
}
