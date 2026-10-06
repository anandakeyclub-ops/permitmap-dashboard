// Read-only capability probe for the DEPLOYED webhook's Stripe key. Each probe is a single LIST/RETRIEVE; nothing is written.
export type ProbeStatus = 'OK' | 'PERMISSION_DENIED' | 'ERROR';
export interface ProbeResult { probe: string; status: ProbeStatus; detail?: string }
export const PROBES: { probe: string; needs: string; run: (s: any) => Promise<any> }[] = [
  { probe: 'invoices.list', needs: 'Invoices: Read  (renewal-conversion classification)', run: s => s.invoices.list({ limit: 1, status: 'paid' }) },
  { probe: 'subscriptions.list', needs: 'Subscriptions: Read  (duplicate/promotion lookups)', run: s => s.subscriptions.list({ limit: 1, status: 'all' }) },
  { probe: 'customers.list', needs: 'Customers: Read  (email → identity)', run: s => s.customers.list({ limit: 1 }) },
];
export function classifyProbeError(e: any): ProbeStatus {
  const msg = String(e?.message || e), code = e?.code || e?.raw?.code, type = e?.type || e?.raw?.type;
  return (e?.statusCode === 403 || e?.raw?.statusCode === 403 || code === 'permission_error' || type === 'StripePermissionError' || /does not have the required permissions|permission/i.test(msg)) ? 'PERMISSION_DENIED' : 'ERROR';
}
export async function runProbes(stripe: any): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const p of PROBES) {
    try { await p.run(stripe); out.push({ probe: p.probe, status: 'OK' }); }
    catch (e: any) { out.push({ probe: p.probe, status: classifyProbeError(e), detail: String(e?.message || e).slice(0, 140) }); }
  }
  return out;
}
export const keyShape = (k: string) => /^sk_live_/.test(k) ? 'secret-live (full access)' : /^rk_live_/.test(k) ? 'restricted-live' : /_test_/.test(k) ? 'TEST (wrong instance)' : 'unrecognised';
