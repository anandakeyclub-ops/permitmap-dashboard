'use client';

import { useEffect, useState } from 'react';
import { CreditCard, CheckCircle2, Circle, ArrowRight, ShieldCheck } from 'lucide-react';
import { apiFetch, type GetToken } from '../../../lib/api';
import { billingMessage, money, type SubscriptionSnapshot } from '../../../lib/subscription-summary';

interface ActivationState {
  first_permit_drawer_open_at: string | null;
  first_csv_export_at: string | null;
  first_saved_lead_at: string | null;
  returned_next_day: boolean;
}

export default function SubscriberValueCard({
  getToken, tier, savedLeadCount, onOpportunities, onPermits, onSaved,
}: {
  getToken: GetToken;
  tier: string;
  savedLeadCount: number;
  onOpportunities: () => void;
  onPermits: () => void;
  onSaved: () => void;
}) {
  const [subscription, setSubscription] = useState<SubscriptionSnapshot | null>(null);
  const [activation, setActivation] = useState<ActivationState | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/subscription', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      apiFetch('/analytics/activation', getToken).then(r => r.ok ? r.json() : null),
    ]).then(([s, a]) => {
      if (s) setSubscription(s);
      if (a) setActivation(a);
    }).catch(() => {});
  }, [getToken]);

  async function manageBilling() {
    setPortalBusy(true);
    try {
      const r = await fetch('/api/billing-portal', { method: 'POST' });
      const data = await r.json();
      if (r.ok && data.url) window.location.href = data.url;
    } finally {
      setPortalBusy(false);
    }
  }

  const tasks = [
    { done: !!activation?.first_permit_drawer_open_at, label: 'Review a top opportunity', action: onOpportunities },
    { done: savedLeadCount > 0 || !!activation?.first_saved_lead_at, label: 'Save your first lead', action: onOpportunities },
    { done: !!activation?.first_csv_export_at, label: 'Export a call list', action: onPermits },
    { done: !!activation?.returned_next_day, label: 'Return after your next delivery', action: onSaved },
  ];
  const completed = tasks.filter(t => t.done).length;

  return (
    <section aria-label="Subscription and value progress" style={{
      background: '#111827', border: '1px solid #1e293b', borderRadius: 14,
      padding: '18px 20px', marginBottom: 24,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 240, flex: '1 1 280px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
            <ShieldCheck size={18} color="#22c55e" />
            <strong style={{ color: '#f1f5f9', textTransform: 'capitalize' }}>
              PermitMap {subscription?.plan || tier}
            </strong>
            {subscription && (
              <span style={{ color: '#94a3b8', fontSize: 12 }}>
                {money(subscription.amount, subscription.currency)}/month
              </span>
            )}
          </div>
          <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.55, margin: '0 0 10px' }}>
            {subscription ? billingMessage(subscription) : 'Your subscription includes dashboard access and recurring permit delivery.'}
          </p>
          <p style={{ color: '#64748b', fontSize: 12, lineHeight: 1.5, margin: '0 0 12px' }}>
            Your email is the weekly summary. The dashboard is where you rank, filter, save,
            export, and track the permits worth working.
          </p>
          {subscription && (
            <button onClick={manageBilling} disabled={portalBusy} className="pm-btn-secondary">
              <CreditCard size={14} /> {portalBusy ? 'Opening…' : 'Manage billing'}
            </button>
          )}
        </div>

        <div style={{ minWidth: 280, flex: '1 1 360px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <strong style={{ color: '#e2e8f0', fontSize: 13 }}>Get value from this week</strong>
            <span style={{ color: completed === tasks.length ? '#22c55e' : '#60a5fa', fontSize: 12 }}>
              {completed}/{tasks.length} complete
            </span>
          </div>
          <div style={{ display: 'grid', gap: 7 }}>
            {tasks.map(task => (
              <button key={task.label} onClick={task.action} style={{
                display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                background: 'transparent', border: 0, padding: '4px 0', cursor: 'pointer',
                color: task.done ? '#94a3b8' : '#e2e8f0', fontSize: 13,
              }}>
                {task.done ? <CheckCircle2 size={16} color="#22c55e" /> : <Circle size={16} color="#475569" />}
                <span style={{ textDecoration: task.done ? 'line-through' : 'none' }}>{task.label}</span>
                {!task.done && <ArrowRight size={14} color="#60a5fa" style={{ marginLeft: 'auto' }} />}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
