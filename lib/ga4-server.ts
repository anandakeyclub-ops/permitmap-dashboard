export const GA4_MEASUREMENT_ID = 'G-GS15YJGKV1';

type Ga4ServerEvent = {
  name: 'trial_started' | 'purchase';
  clientId: string;
  params: Record<string, string | number | boolean | undefined>;
};

function cleanParams(params: Ga4ServerEvent['params']) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== ''));
}

/**
 * Server-side GA4 Measurement Protocol bridge for verified Stripe lifecycle events.
 * Never send email, Clerk IDs, customer IDs, or other PII. Stripe session/invoice IDs
 * are used only as transaction/deduplication identifiers.
 */
export async function sendGa4ServerEvent(event: Ga4ServerEvent): Promise<void> {
  const apiSecret = process.env.GA4_API_SECRET;
  if (!apiSecret) {
    console.warn('GA4_API_SECRET unset — skipping server conversion emit');
    return;
  }
  const endpoint =
    `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(apiSecret)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: event.clientId,
      events: [{ name: event.name, params: cleanParams(event.params) }],
    }),
  });
  if (!response.ok) throw new Error(`GA4 Measurement Protocol failed: ${response.status}`);
}
