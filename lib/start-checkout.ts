// Single client-side entry point for starting a subscription. Every subscription CTA
// calls this — no anonymous buy.stripe.com Payment Links. It POSTs to the authenticated
// /api/checkout route; if the visitor isn't signed in (401) it routes them to sign-in
// first (checkout requires a Clerk identity — the root-cause fix).

import type { IntentParams } from './checkout-intent';

export interface StartCheckoutDeps {
  fetchFn?: typeof fetch;
  navigate?: (url: string) => void;
  currentPath?: string;
  // Allowlisted attribution to forward into the Checkout Session metadata. In-app
  // upgrade CTAs omit it (no marketing context); the resume flow passes it through.
  attribution?: IntentParams | null;
}

export async function startCheckout(
  plan: 'starter' | 'pro' | 'team',
  deps: StartCheckoutDeps = {},
): Promise<{ action: 'checkout' | 'signin' | 'error'; url?: string }> {
  const f = deps.fetchFn || (typeof fetch !== 'undefined' ? fetch : undefined);
  const nav = deps.navigate || ((u: string) => { if (typeof window !== 'undefined') window.location.href = u; });
  const path = deps.currentPath || (typeof window !== 'undefined' ? window.location.pathname : '/pricing');
  if (!f) return { action: 'error' };

  const res = await f('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deps.attribution ? { plan, attribution: deps.attribution } : { plan }),
  });

  if (res.status === 401) {
    const url = `/sign-in?redirect_url=${encodeURIComponent(path)}`;
    nav(url);
    return { action: 'signin', url };
  }
  const data = await res.json().catch(() => ({} as any));
  if (data && data.url) {
    nav(data.url);
    return { action: 'checkout', url: data.url };
  }
  return { action: 'error' };
}
