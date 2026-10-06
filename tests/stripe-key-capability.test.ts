import { describe, it, expect } from 'vitest';
import { classifyProbeError, runProbes, keyShape } from '../scripts/forensics/stripe-key-capability-core';
describe('stripe key capability probe', () => {
  it('classifies permission errors vs other errors', () => {
    expect(classifyProbeError({ statusCode: 403, message: 'x' })).toBe('PERMISSION_DENIED');
    expect(classifyProbeError({ type: 'StripePermissionError', message: 'This API call cannot be made with a restricted key' })).toBe('PERMISSION_DENIED');
    expect(classifyProbeError(new Error('ECONNRESET'))).toBe('ERROR');
  });
  it('reports each probe independently and only calls list methods', async () => {
    const calls: string[] = [];
    const ok = (n: string) => async () => { calls.push(n); return { data: [] }; };
    const s: any = { invoices: { list: async () => { calls.push('invoices.list'); throw { statusCode: 403, message: 'no invoices' }; } }, subscriptions: { list: ok('subscriptions.list') }, customers: { list: ok('customers.list') } };
    const r = await runProbes(s);
    expect(r.map(x => x.status)).toEqual(['PERMISSION_DENIED', 'OK', 'OK']); expect(calls).toEqual(['invoices.list', 'subscriptions.list', 'customers.list']);
  });
  it('key shape never echoes the key', () => { expect(keyShape('sk_live_abc')).not.toContain('abc'); expect(keyShape('sk_test_x')).toMatch(/TEST/); expect(keyShape('rk_live_x')).toBe('restricted-live'); });
});
