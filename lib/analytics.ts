// First-party funnel analytics → permitmap-api POST /analytics/event (Supabase).
// Fire-and-forget and NEVER throws — analytics must never affect the UI or checkout.
// The API derives user_id/email/tier from the Clerk JWT; we only pass funnel context.

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

type GetToken = (options?: { template?: string }) => Promise<string | null>;

// Client-emittable funnel events (server emits trial_started / paid_subscription_started).
export type FunnelEvent =
  | 'locked_county_view'
  | 'upgrade_modal_open'
  | 'upgrade_plan_selected'
  | 'upgrade_cta_click'
  | 'stripe_checkout_started';

export interface TrackProps {
  county?: string;
  plan?: string;
  source?: string;
  client_reference_id?: string;
  properties?: Record<string, unknown>;
}

export function track(getToken: GetToken | undefined, event: FunnelEvent, props: TrackProps = {}): void {
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
