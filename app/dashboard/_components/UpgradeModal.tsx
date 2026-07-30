'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, Lock, MapPin, TrendingUp, DollarSign, Building2, Check } from 'lucide-react';
import { apiFetch } from '../../../lib/api';
import { type Plan } from '../../../lib/checkout';
import { startCheckout } from '../../../lib/start-checkout';
import { track } from '../../../lib/analytics';

type GetToken = (options?: { template?: string }) => Promise<string | null>;

// 3 A/B-ready headline variants. Selected stably per user so a user always sees the
// same one; the variant id rides along on every event for analysis.
function headlineVariants(planLabel: string, counties: number): { id: string; text: string }[] {
  return [
    { id: 'A', text: 'Unlock More Contractor Opportunities' },
    { id: 'B', text: `You're Limited to ${counties} ${counties === 1 ? 'County' : 'Counties'} on ${planLabel}` },
    { id: 'C', text: 'See Every Opportunity Across Florida' },
  ];
}

function pickVariant(userId: string | null | undefined, n: number): number {
  if (!userId) return 1; // default to Variant B when anonymous
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return h % n;
}

const PLANS: { plan: Plan; label: string; counties: string; opps: string }[] = [
  { plan: 'starter', label: 'Starter', counties: '1 county',       opps: '50 opportunities' },
  { plan: 'pro',     label: 'Pro',     counties: '5 counties',     opps: '500 opportunities' },
  { plan: 'team',    label: 'Team',    counties: 'All counties',   opps: 'Unlimited opportunities' },
];

function money(v: any): string {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return isNaN(n) || n <= 0 ? '' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function UpgradeModal({
  countyKey, countyLabel, countyCount, entitlementNote, tier, limits, userId, getToken, onClose,
  trigger = 'locked_county',
}: {
  countyKey?: string;              // optional — absent when opened generically
  countyLabel?: string;
  countyCount?: number;            // fallback permit count from /counties
  entitlementNote?: string;        // D: explains what the trial/plan currently includes
  tier: string;
  limits: { counties: number; permits: number; label: string };
  userId?: string | null;
  getToken?: GetToken;
  onClose: () => void;
  trigger?: 'locked_county' | 'get_full_access_button';
}) {
  // Generic mode (e.g. "Get Full Access" button): no specific county in context.
  const isGeneric = !countyKey;
  const variants = headlineVariants(limits.label, limits.counties);
  const variant = variants[pickVariant(userId, variants.length)];
  const [selected, setSelected] = useState<Plan>('pro'); // Pro highlighted by default
  const [kpis, setKpis] = useState<any>(null);

  // Real data for the locked county. Best-effort — modal still works if it fails.
  // Skipped in generic mode (no county to summarize).
  useEffect(() => {
    if (!countyKey) return;
    let cancelled = false;
    apiFetch(`/summary?county=${countyKey}`, getToken)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setKpis(d.kpis || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [countyKey, getToken]);

  // Fire upgrade_modal_open once, with the variant + trigger.
  useEffect(() => {
    track(getToken, 'upgrade_modal_open', {
      county: countyKey || undefined,
      source: trigger === 'get_full_access_button' ? 'get_full_access_button' : 'county_sidebar',
      properties: { variant: variant.id, trigger },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selectPlan = (p: Plan) => {
    if (p === selected) return;
    setSelected(p);
    track(getToken, 'upgrade_plan_selected', { plan: p, county: countyKey, properties: { variant: variant.id } });
  };

  const startTrial = () => {
    // Conversion event with trigger context (county vs Get Full Access button).
    track(getToken, 'upgrade_modal_cta_click', {
      county: countyKey || undefined,
      properties: { trigger, county: countyLabel ?? null, plan_highlighted: 'pro', variant: variant.id },
    });
    // client_reference_id is now set server-side (= Clerk user id) by /api/checkout.
    track(getToken, 'upgrade_cta_click', {
      plan: selected, county: countyKey,
      client_reference_id: userId || undefined,
      properties: { variant: variant.id },
    });
    track(getToken, 'stripe_checkout_started', {
      plan: selected, county: countyKey,
      client_reference_id: userId || undefined,
      properties: { variant: variant.id },
    });
    // Authenticated, server-side Checkout Session (no anonymous Payment Link).
    void startCheckout(selected); // analytics uses keepalive → survives navigation
  };

  const totalPermits = kpis?.total_permits ?? countyCount;
  const highValue    = kpis?.high_value_count;
  const topTrade     = (kpis?.top_trade || '').replace('_', ' ');
  const avgValue     = money(kpis?.avg_value);

  // Real-data chips — each renders only when its value is present (no fabricated numbers).
  const chips: { icon: any; label: string; value: string }[] = [];
  if (typeof totalPermits === 'number' && totalPermits > 0)
    chips.push({ icon: Building2, label: 'Permits this week', value: totalPermits.toLocaleString() });
  if (typeof highValue === 'number' && highValue > 0)
    chips.push({ icon: TrendingUp, label: 'High-value opportunities', value: highValue.toLocaleString() });
  if (topTrade) chips.push({ icon: MapPin, label: 'Most active trade', value: topTrade });
  if (avgValue) chips.push({ icon: DollarSign, label: 'Avg project value', value: avgValue });

  return (
    <div onClick={onClose} className="pm-upg-overlay">
      {/* Inline styles can't express media queries — this block makes the modal
          a centered card on desktop and full-screen on mobile (<= 640px). */}
      <style>{`
        .pm-upg-overlay { position: fixed; inset: 0; background: rgba(2,6,23,0.72);
          z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .pm-upg-dialog { background: #0d1529; border: 1px solid #1e293b; border-radius: 16px;
          width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto;
          padding: 24px 26px; box-shadow: 0 24px 64px rgba(0,0,0,0.55); }
        @media (max-width: 640px) {
          .pm-upg-overlay { padding: 0; }
          .pm-upg-dialog { max-width: 100%; max-height: 100vh; height: 100vh;
            border-radius: 0; border: none; padding: 20px 18px; }
        }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Upgrade"
        className="pm-upg-dialog"
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#f59e0b20',
              border: '2px solid #f59e0b', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Lock size={17} color="#f59e0b" />
            </div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
              {variant.text}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: '#475569', padding: 4 }}>
            <X size={20} />
          </button>
        </div>

        {/* D: explain the current entitlement instead of a bare "Upgrade". */}
        {entitlementNote && (
          <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.5, color: '#cbd5e1' }}>
            {entitlementNote}
          </p>
        )}

        {/* What they're trying to access */}
        <div style={{ margin: '16px 0', padding: '14px 16px', borderRadius: 12,
          background: 'linear-gradient(135deg, #1e3a5f 0%, #0d1529 100%)', border: '1px solid #2563eb40' }}>
          <div style={{ fontSize: 11, color: '#60a5fa', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 6 }}>
            {isGeneric ? 'With full access' : "You're trying to open"}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#f1f5f9' }}>
            {isGeneric ? 'Every county across Florida & Texas' : countyLabel}
          </div>
          {chips.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12, marginTop: 12 }}>
              {chips.map((c, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <c.icon size={15} color="#60a5fa" style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0', textTransform: 'capitalize' }}>{c.value}</div>
                    <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{c.label}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Current plan / access */}
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 16 }}>
          You're on <strong style={{ color: '#e2e8f0' }}>{limits.label}</strong> — {limits.counties}{' '}
          {limits.counties === 1 ? 'county' : 'counties'} and {limits.permits.toLocaleString()} opportunities.
        </div>

        {/* Social proof — factual, no testimonials/numbers */}
        <div style={{ fontSize: 13, color: '#cbd5e1', background: '#111827', border: '1px solid #1e293b',
          borderRadius: 10, padding: '10px 14px', marginBottom: 18 }}>
          Contractors use PermitMap to prioritize the highest-value jobs first.
        </div>

        {/* Plan selection / comparison — Pro highlighted by default */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
          {PLANS.map(p => {
            const active = p.plan === selected;
            return (
              <button key={p.plan} onClick={() => selectPlan(p.plan)} style={{
                textAlign: 'left', cursor: 'pointer', borderRadius: 12, padding: '12px 12px',
                background: active ? '#2563eb18' : '#111827',
                border: `1.5px solid ${active ? '#2563eb' : '#1e293b'}`, position: 'relative',
              }}>
                {active && (
                  <span style={{ position: 'absolute', top: 8, right: 8, color: '#2563eb' }}><Check size={15} /></span>
                )}
                <div style={{ fontSize: 13, fontWeight: 800, color: active ? '#93c5fd' : '#e2e8f0' }}>{p.label}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{p.counties}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{p.opps}</div>
              </button>
            );
          })}
        </div>

        {/* CTAs */}
        <button onClick={startTrial} style={{
          width: '100%', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10,
          padding: '13px 20px', fontSize: 15, fontWeight: 800, cursor: 'pointer', marginBottom: 8,
        }}>
          Start 14-Day Trial
        </button>
        <button onClick={onClose} style={{
          width: '100%', background: 'transparent', color: '#64748b', border: 'none',
          padding: '8px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}>
          Maybe Later
        </button>
        <p style={{ textAlign: 'center', fontSize: 11, color: '#475569', margin: '6px 0 0' }}>
          $0 due today · 14-day trial
        </p>
      </div>
    </div>
  );
}
