import { describe, expect, it } from 'vitest';
import { billingMessage, money, shortDate } from '../lib/subscription-summary';

describe('subscription billing clarity', () => {
  const base = {
    status: 'active', plan: 'pro', amount: 14900, currency: 'usd',
    trial_end: null, current_period_end: 1791425605, cancel_at_period_end: false,
  };

  it('states the recurring amount and renewal date for active plans', () => {
    expect(billingMessage(base)).toContain('Renews');
    expect(billingMessage(base)).toContain('$149/month');
  });

  it('states trial conversion terms without implying a charge already occurred', () => {
    const msg = billingMessage({ ...base, status: 'trialing', trial_end: 1791425605 });
    expect(msg).toContain('Trial ends');
    expect(msg).toContain('then $149/month');
  });

  it('makes scheduled cancellation explicit', () => {
    expect(billingMessage({ ...base, cancel_at_period_end: true })).toContain('Access ends');
  });

  it('formats money and dates safely', () => {
    expect(money(29900)).toBe('$299');
    expect(money(null)).toBe('—');
    expect(shortDate(null)).toBe('—');
  });
});
