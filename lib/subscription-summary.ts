export interface SubscriptionSnapshot {
  status: string;
  plan: string;
  amount: number | null;
  currency: string;
  trial_end: number | null;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
}

export function money(amount: number | null, currency = 'usd'): string {
  if (amount === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0,
  }).format(amount / 100);
}

export function shortDate(unix: number | null): string {
  if (!unix) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(unix * 1000));
}

export function billingMessage(s: SubscriptionSnapshot): string {
  if (s.cancel_at_period_end) return `Access ends ${shortDate(s.current_period_end)}`;
  if (s.status === 'trialing') return `Trial ends ${shortDate(s.trial_end)}; then ${money(s.amount, s.currency)}/month`;
  if (s.status === 'active') return `Renews ${shortDate(s.current_period_end)} at ${money(s.amount, s.currency)}/month`;
  if (s.status === 'past_due') return 'Payment needs attention';
  return `Billing status: ${s.status.replace(/_/g, ' ')}`;
}
