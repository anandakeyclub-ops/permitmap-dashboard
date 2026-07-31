import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css'; // app-global styles (spinner keyframe) — see app/globals.css

export const metadata: Metadata = {
  title: 'PermitMap — Construction Intelligence',
  description: 'Building permit data and market intelligence for contractors',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body style={{ margin: 0, padding: 0 }}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
