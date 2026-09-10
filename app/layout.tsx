import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import Script from 'next/script';
import './globals.css'; // app-global styles (spinner keyframe) — see app/globals.css

export const metadata: Metadata = {
  title: 'PermitMap — Construction Intelligence',
  description: 'Building permit data and market intelligence for contractors',
};

const GA4_MEASUREMENT_ID = 'G-GS15YJGKV1';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body style={{ margin: 0, padding: 0 }}>
          {children}
          <Script
            src={`https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`}
            strategy="afterInteractive"
          />
          <Script id="permitmap-ga4" strategy="afterInteractive">
            {`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              window.gtag = window.gtag || gtag;
              gtag('js', new Date());
              gtag('config', '${GA4_MEASUREMENT_ID}');
            `}
          </Script>
        </body>
      </html>
    </ClerkProvider>
  );
}
