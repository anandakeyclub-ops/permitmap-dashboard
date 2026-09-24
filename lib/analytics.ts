// First-party funnel analytics → permitmap-api POST /analytics/event (Supabase).
// Fire-and-forget and NEVER throws — analytics must never affect the UI or checkout.
// The API derives user_id/email/tier from the Clerk JWT; we only pass funnel context.
// Selected commercial-funnel events are also mirrored to the public PermitMap GA4 property.

import type { ActivationEvent } from './activationEvents';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

type GetToken = (options?: { template?: string }) => Promise<string | null>;

// Client-emittable funnel events (server emits trial_started / paid_subscription_started).
export type FunnelEvent =
  | 'locked_county_view'
  | 'upgrade_modal_open'
  | 'upgrade_plan_selected'
  | 'upgrade_cta_click'
  | 'upgrade_modal_cta_click'
  | 'stripe_checkout_started'
  | 'checkout_resume_failed'
  // Signup → Stripe checkout observability funnel (see lib/funnel-events.ts). Additive; the
  // events above are unchanged (historical reporting depends on them).
  | 'signup_page_view'
  | 'signup_completed'
  | 'checkout_resume_started'
  | 'stripe_checkout_created'
  | 'checkout_creation_failed';

// Lifecycle activation events (defined + built in lib/activationEvents; server allowlist mirrors
// these). Kept as a separate union so the funnel taxonomy above is untouched.
export type AnalyticsEvent = FunnelEvent | ActivationEvent;

export interface TrackProps {
  county?: string;
  plan?: string;
  source?: string;
  client_reference_id?: string;
  properties?: Record<string, unknown>;
}

// Keep GA4 narrowly scoped to the commercial checkout funnel. Product-activation events remain
// first-party only so this bridge cannot inflate GA4 engagement or conversion reporting.
const GA4_FUNNEL_EVENTS = new Set<AnalyticsEvent>([
  'signup_page_view',
  'signup_completed',
  'checkout_resume_started',
  'stripe_checkout_created',
  'checkout_creation_failed',
  'stripe_checkout_started',
  'checkout_resume_failed',
]);

function mirrorToClarity(event: AnalyticsEvent, props: TrackProps): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as typeof window & { clarity?: (...args: unknown[]) => void };
    if (typeof w.clarity !== 'function') return;
    w.clarity('event', event);
    if (props.plan) w.clarity('set', 'plan', props.plan);
    if (props.source) w.clarity('set', 'source', props.source);
    if (props.county) w.clarity('set', 'county', props.county);
  } catch { /* Clarity is best-effort; first-party analytics remains authoritative. */ }
}

function mirrorToGa4(event: AnalyticsEvent, props: TrackProps): void {
  if (typeof window === 'undefined' || !GA4_FUNNEL_EVENTS.has(event)) return;
  try {
    const w = window as typeof window & {
      dataLayer?: unknown[];
      gtag?: (...args: unknown[]) => void;
    };
    w.dataLayer = w.dataLayer || [];
    // Queue safely even if the external gtag script has not finished loading yet. Use the
    // canonical gtag queue shape (the function's `arguments` object), not a rest-parameter array;
    // Google's loader consumes the canonical shape when it drains dataLayer.
    w.gtag = w.gtag || (function (..._args: unknown[]) { w.dataLayer!.push(arguments); } as typeof w.gtag);
    w.gtag('event', event, {
      ...(props.plan ? { plan: props.plan } : {}),
      ...(props.source ? { source: props.source } : {}),
      ...(props.county ? { county: props.county } : {}),
    });
  } catch {
    /* GA4 is best-effort; first-party analytics remains authoritative. */
  }
}

export function track(getToken: GetToken | undefined, event: AnalyticsEvent, props: TrackProps = {}): void {
  // Mirror synchronously before a navigation can unload the page. No PII or opaque IDs are sent.
  mirrorToGa4(event, props);
  mirrorToClarity(event, props);

  // Detached async; nothing awaits it, and every failure path is swallowed.
  void (async () => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (getToken) {
        try {
          const token = await getToken({ template: 'api' });
          if (token) headers['Authorization'] = `Bearer ${token}`;
        } catch { /* no token — API will 401 the client path; non-fatal */ }
      }
      await fetch(`${API_BASE}/analytics/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ event_name: event, ...props }),
        keepalive: true, // survive the navigation to Stripe (stripe_checkout_started)
      });
    } catch {
      /* analytics is best-effort; never surface to the user */
    }
  })();
}
