import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendGa4ServerEvent, GA4_MEASUREMENT_ID } from '../lib/ga4-server';

describe('GA4 server conversion bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GA4_API_SECRET;
  });

  it('is a no-op when GA4_API_SECRET is absent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await sendGa4ServerEvent({ name: 'trial_started', clientId: 'stripe.cs_1', params: { transaction_id: 'cs_1' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a PII-free Measurement Protocol event with stable transaction id', async () => {
    process.env.GA4_API_SECRET = 'secret';
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    await sendGa4ServerEvent({
      name: 'purchase',
      clientId: 'stripe.sub_1',
      params: { transaction_id: 'in_1', value: 149, currency: 'USD', plan: 'pro' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as any;
    expect(url).toContain(`measurement_id=${GA4_MEASUREMENT_ID}`);
    const body = JSON.parse(init.body);
    expect(body.client_id).toBe('stripe.sub_1');
    expect(body.events[0]).toEqual({
      name: 'purchase',
      params: { transaction_id: 'in_1', value: 149, currency: 'USD', plan: 'pro' },
    });
    expect(JSON.stringify(body)).not.toContain('email');
    expect(JSON.stringify(body)).not.toContain('clerk');
  });
});
