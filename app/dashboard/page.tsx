'use client';

import { useEffect, useState } from 'react';
import { useUser, useAuth } from '@clerk/nextjs';
import { apiFetch } from '../../lib/api';
import CallList from './_components/CallList';
import DigestCard from './_components/DigestCard';
import UpgradeModal from './_components/UpgradeModal';
import { track } from '../../lib/analytics';
import { TRIAL_LINKS } from '../../lib/checkout';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import {
  MapPin, TrendingUp, Zap, Building2, Target,
  ChevronRight, Star, AlertCircle, Lock
} from 'lucide-react';

// API base + auth lives in lib/api.ts (apiFetch attaches the Clerk JWT when available).

// Tier limits
const TIER_LIMITS: Record<string, { counties: number; permits: number; label: string }> = {
  starter: { counties: 1, permits: 50,  label: 'Starter' },
  pro:     { counties: 5, permits: 500, label: 'Pro' },
  team:    { counties: 99, permits: 9999, label: 'Team' },
};

const TRADE_COLORS: Record<string, string> = {
  roofing:            '#ef4444',
  hvac:               '#f97316',
  electrical:         '#eab308',
  plumbing:           '#3b82f6',
  pool:               '#06b6d4',
  solar:              '#22c55e',
  general_contractor: '#8b5cf6',
};

const SCORE_COLOR = (s: number) =>
  s >= 80 ? '#22c55e' : s >= 60 ? '#f97316' : s >= 40 ? '#eab308' : '#6b7280';

// Trial-enabled Stripe checkout links — single source of truth in lib/checkout.ts.
const CHECKOUT = TRIAL_LINKS;

// Phase 1.5: shown to authenticated users with no paid tier (preview entitlement).
// The API returns counts only (preview_locked=true) and zero permit rows, so we
// never render addresses/owners — we render the upgrade path instead.
function PreviewLock({ compact = false }: { compact?: boolean }) {
  return (
    <div style={{
      background: 'linear-gradient(135deg, #1e3a5f 0%, #0d1529 100%)',
      border: '1px solid #f59e0b40',
      borderRadius: 12,
      padding: compact ? '24px 28px' : '32px 36px',
      textAlign: 'center',
      marginBottom: 28,
    }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 48, height: 48, borderRadius: '50%', background: '#f59e0b20',
        border: '2px solid #f59e0b', marginBottom: 14 }}>
        <Lock size={22} color="#f59e0b" />
      </div>
      <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>
        Preview mode
      </h3>
      <p style={{ margin: '0 auto 20px', fontSize: 14, color: '#cbd5e1',
        maxWidth: 520, lineHeight: 1.6 }}>
        Start your 14-day trial to unlock permit addresses, owners, saved leads,
        and scored opportunities.
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        <a href={CHECKOUT.starter} style={{
          background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700,
          padding: '10px 22px', borderRadius: 8, textDecoration: 'none' }}>
          Start Starter trial →
        </a>
        <a href={CHECKOUT.pro} style={{
          background: 'transparent', color: '#93c5fd', fontSize: 13, fontWeight: 600,
          padding: '10px 18px', borderRadius: 8, textDecoration: 'none',
          border: '1px solid #2563eb60' }}>
          Pro
        </a>
        <a href={CHECKOUT.team} style={{
          background: 'transparent', color: '#93c5fd', fontSize: 13, fontWeight: 600,
          padding: '10px 18px', borderRadius: 8, textDecoration: 'none',
          border: '1px solid #2563eb60' }}>
          Team
        </a>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useUser();
  const { getToken } = useAuth();
  const tier = (user?.publicMetadata?.tier as string) || 'starter';
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.starter;

  const [counties, setCounties]     = useState<any[]>([]);
  const [county, setCounty]         = useState('palm_beach');
  const [summary, setSummary]       = useState<any>(null);
  const [permits, setPermits]       = useState<any[]>([]);
  const [scored, setScored]         = useState<any[]>([]);
  const [digest, setDigest]         = useState<any>(null);
  const [loading, setLoading]       = useState(true);
  const [activeTab, setActiveTab]   = useState<'opportunities' | 'permits' | 'trends' | 'insights'>('opportunities');
  const [tradeFilter, setTradeFilter] = useState('');
  const [upgrade, setUpgrade] = useState<
    { trigger: 'locked_county' | 'get_full_access_button'; county: any | null } | null
  >(null);

  // Locked county click → record the lock view and open the upgrade modal
  // (instead of silently doing nothing). The modal fires upgrade_modal_open itself.
  const openUpgrade = (c: any) => {
    track(getToken, 'locked_county_view', { county: c.key, source: 'county_sidebar' });
    setUpgrade({ trigger: 'locked_county', county: c });
  };

  // "Get Full Access" button → open the modal generically (no specific county).
  const openFullAccess = () => setUpgrade({ trigger: 'get_full_access_button', county: null });

  // Load counties
  useEffect(() => {
    apiFetch('/counties', getToken)
      .then(r => r.json())
      .then(d => setCounties(d.counties || []))
      .catch(() => {});
  }, [getToken]);

  // Load summary + permits when county changes
  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiFetch(`/summary?county=${county}`, getToken).then(r => r.json()),
      apiFetch(`/permits?county=${county}&limit=${limits.permits}`, getToken).then(r => r.json()),
      // Phase A: ranked opportunities. 403 for preview/no-tier -> empty (the tab shows PreviewLock).
      apiFetch(`/permits/scored?county=${county}&top_n=50`, getToken)
        .then(r => (r.ok ? r.json() : { permits: [] }))
        .catch(() => ({ permits: [] })),
      // Phase B: weekly digest briefing. 403 for preview/no-tier -> null (card hidden).
      apiFetch(`/digest?county=${county}`, getToken)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([s, p, sc, dg]) => {
      setSummary(s);
      setPermits(p.permits || []);
      setScored(sc.permits || []);
      setDigest(dg);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [county, limits.permits, getToken]);

  // Phase B: digest CTA -> switch to the Opportunity Queue and scroll it into view.
  const goToQueue = () => {
    setActiveTab('opportunities');
    setTimeout(() => {
      document.getElementById('opportunities-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  // Phase 1.5: the API is authoritative — a preview (unpaid) caller gets
  // preview_locked=true and zero rows. Never trust client metadata for gating.
  const isPreview = summary?.preview_locked === true;

  const filteredPermits = tradeFilter
    ? permits.filter(p => p.trade === tradeFilter)
    : permits;

  const tradeChartData = summary?.trade_breakdown
    ? Object.entries(summary.trade_breakdown).map(([trade, count]) => ({
        trade: trade.replace('_', ' '),
        count: count as number,
        fill: TRADE_COLORS[trade] || '#6b7280',
      }))
    : [];

  const isLocked = (countyIndex: number) => countyIndex >= limits.counties;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0f1e',
      color: '#e2e8f0',
      fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
    }}>

      {/* Header */}
      <header style={{
        borderBottom: '1px solid #1e293b',
        padding: '0 32px',
        height: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#0d1529',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <MapPin size={22} color="#3b82f6" />
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.02em' }}>
            permit<span style={{ color: '#3b82f6' }}>map</span>
          </span>
          <span style={{
            background: '#1e3a5f',
            color: '#60a5fa',
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 4,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>{limits.label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>
            {user?.emailAddresses?.[0]?.emailAddress}
          </span>
          {tier !== 'team' && (
            <button onClick={openFullAccess} style={{
              background: '#2563eb',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
            }}>Get Full Access</button>
          )}
        </div>
      </header>

      <div style={{ display: 'flex', height: 'calc(100vh - 60px)' }}>

        {/* Sidebar — County selector */}
        <aside style={{
          width: 220,
          borderRight: '1px solid #1e293b',
          padding: '20px 0',
          overflowY: 'auto',
          flexShrink: 0,
          background: '#0d1529',
        }}>
          <div style={{ padding: '0 16px 12px', fontSize: 10, fontWeight: 700,
            color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Counties
          </div>
          {counties.map((c, i) => {
            const locked = isLocked(i);
            const active = c.key === county;
            return (
              <button key={c.key} onClick={() => (locked ? openUpgrade(c) : setCounty(c.key))}
                style={{
                  width: '100%', textAlign: 'left', padding: '10px 16px',
                  background: active ? '#1e3a5f' : 'transparent',
                  border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  opacity: locked ? 0.4 : 1,
                  borderLeft: active ? '3px solid #3b82f6' : '3px solid transparent',
                }}>
                <span style={{ fontSize: 13, color: active ? '#93c5fd' : '#94a3b8', fontWeight: active ? 600 : 400 }}>
                  {c.label}
                </span>
                {locked ? <Lock size={12} color="#475569" /> :
                  <span style={{ fontSize: 11, color: '#475569' }}>{c.count}</span>}
              </button>
            );
          })}
          {tier !== 'team' && (
            <div style={{ margin: '16px', padding: '12px', background: '#1e293b',
              borderRadius: 8, textAlign: 'center' }}>
              <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 8px' }}>
                {limits.counties === 1 ? 'Upgrade for 5 counties' : 'Upgrade for all counties'}
              </p>
              <a href="/pricing" style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>
                Upgrade →
              </a>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '28px 32px' }}>

          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '60vh', flexDirection: 'column', gap: 12 }}>
              <div style={{ width: 40, height: 40, border: '3px solid #1e293b',
                borderTop: '3px solid #3b82f6', borderRadius: '50%',
                animation: 'spin 1s linear infinite' }} />
              <span style={{ color: '#475569', fontSize: 13 }}>Loading permit data...</span>
            </div>
          ) : !summary ? (
            <div style={{ color: '#ef4444' }}>Failed to load data.</div>
          ) : (
            <>
              {/* County header */}
              <div style={{ marginBottom: 24 }}>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0,
                  letterSpacing: '-0.03em', color: '#f1f5f9' }}>
                  {summary.label}
                </h1>
                <p style={{ color: '#475569', fontSize: 13, margin: '4px 0 0' }}>
                  Week of {summary.week_of} · {summary.kpis?.total_permits} permits issued
                </p>
              </div>

              {/* Phase B: Weekly Digest Card — 60-second briefing, above the Opportunity Queue.
                  Paid/trial only (digest 403 for preview -> digest stays null -> card hidden). */}
              {!isPreview && digest && (
                <DigestCard digest={digest} label={summary.label} county={county} onView={goToQueue} />
              )}

              {/* KPI Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 16, marginBottom: 28 }}>
                {[
                  { label: 'Total Permits', value: summary.kpis?.total_permits, icon: Building2, color: '#3b82f6' },
                  { label: 'High Value (50k+)', value: summary.kpis?.high_value_count, icon: TrendingUp, color: '#22c55e' },
                  { label: 'Avg Project Value', value: `$${(summary.kpis?.avg_value || 0).toLocaleString(undefined, {maximumFractionDigits: 0})}`, icon: Zap, color: '#f97316' },
                  { label: 'Top Trade', value: (summary.kpis?.top_trade || '').replace('_', ' '), icon: Target, color: '#8b5cf6' },
                ].map(({ label, value, icon: Icon, color }) => (
                  <div key={label} style={{
                    background: '#111827', border: '1px solid #1e293b',
                    borderRadius: 12, padding: '20px 24px',
                    borderTop: `3px solid ${color}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <Icon size={16} color={color} />
                      <span style={{ fontSize: 11, color: '#475569', textTransform: 'uppercase',
                        letterSpacing: '0.08em', fontWeight: 600 }}>{label}</span>
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: '#f1f5f9',
                      letterSpacing: '-0.02em', textTransform: 'capitalize' }}>
                      {value ?? '—'}
                    </div>
                  </div>
                ))}
              </div>

              {/* Phase 1.5: preview users see KPI counts above + locked upgrade path here */}
              {isPreview && <PreviewLock />}

              {/* Smart targeting */}
              {summary.targeting?.recommendation && (
                <div style={{
                  background: 'linear-gradient(135deg, #1e3a5f 0%, #1e293b 100%)',
                  border: '1px solid #2563eb40',
                  borderRadius: 12, padding: '16px 20px',
                  display: 'flex', alignItems: 'center', gap: 12,
                  marginBottom: 28,
                }}>
                  <Target size={20} color="#3b82f6" style={{ flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 11, color: '#60a5fa', fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                      Smart Targeting
                    </div>
                    <div style={{ fontSize: 14, color: '#e2e8f0' }}>
                      {summary.targeting.recommendation}
                    </div>
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 20,
                borderBottom: '1px solid #1e293b', paddingBottom: 0 }}>
                {(['opportunities', 'permits', 'trends', 'insights'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)} style={{
                    padding: '8px 18px', background: 'none', border: 'none',
                    cursor: 'pointer', fontSize: 13, fontWeight: 600,
                    color: activeTab === tab ? '#3b82f6' : '#475569',
                    borderBottom: activeTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
                    textTransform: 'capitalize', marginBottom: -1,
                  }}>{tab}</button>
                ))}
              </div>

              {/* OPPORTUNITIES TAB (Phase A) — the default post-login view */}
              {activeTab === 'opportunities' && isPreview && (
                <PreviewLock compact />
              )}
              {activeTab === 'opportunities' && !isPreview && (
                <div id="opportunities-anchor">
                  <CallList
                    scored={scored}
                    topZips={(summary?.targeting?.top_zips || []).map((z: any) => String(z.zip))}
                  />
                </div>
              )}

              {/* PERMITS TAB */}
              {activeTab === 'permits' && isPreview && (
                <PreviewLock compact />
              )}
              {activeTab === 'permits' && !isPreview && (
                <>
                  {/* Trade filter */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                    {['', 'roofing', 'hvac', 'electrical', 'plumbing', 'pool', 'solar', 'general_contractor'].map(t => (
                      <button key={t} onClick={() => setTradeFilter(t)} style={{
                        padding: '5px 12px', borderRadius: 20,
                        border: `1px solid ${tradeFilter === t ? (TRADE_COLORS[t] || '#3b82f6') : '#1e293b'}`,
                        background: tradeFilter === t ? `${TRADE_COLORS[t] || '#2563eb'}20` : 'transparent',
                        color: tradeFilter === t ? (TRADE_COLORS[t] || '#3b82f6') : '#64748b',
                        fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        textTransform: 'capitalize',
                      }}>
                        {t || 'All Trades'}
                      </button>
                    ))}
                  </div>

                  {/* Permits table */}
                  <div style={{ background: '#111827', border: '1px solid #1e293b',
                    borderRadius: 12, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #1e293b' }}>
                          {['Score', 'Address', 'Type', 'Trade', 'Value', 'Date'].map(h => (
                            <th key={h} style={{ padding: '12px 16px', textAlign: 'left',
                              fontSize: 11, color: '#475569', fontWeight: 700,
                              textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredPermits.slice(0, 50).map((p, i) => (
                          <tr key={i} style={{
                            borderBottom: '1px solid #0f172a',
                            background: i % 2 === 0 ? '#111827' : '#0d1529',
                          }}>
                            <td style={{ padding: '12px 16px' }}>
                              <div style={{
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                width: 36, height: 36, borderRadius: '50%',
                                background: `${SCORE_COLOR(p.score)}20`,
                                border: `2px solid ${SCORE_COLOR(p.score)}`,
                                fontSize: 12, fontWeight: 700,
                                color: SCORE_COLOR(p.score),
                              }}>{p.score}</div>
                            </td>
                            <td style={{ padding: '12px 16px', fontSize: 13, color: '#e2e8f0',
                              maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap' }}>
                              {p.FULL_ADDRESS || p.full_address || '—'}
                            </td>
                            <td style={{ padding: '12px 16px', fontSize: 12, color: '#94a3b8',
                              maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap' }}>
                              {p.RECORD_TYPE || p.record_type || '—'}
                            </td>
                            <td style={{ padding: '12px 16px' }}>
                              <span style={{
                                fontSize: 11, fontWeight: 600, padding: '3px 8px',
                                borderRadius: 4, textTransform: 'capitalize',
                                background: `${TRADE_COLORS[p.trade] || '#475569'}20`,
                                color: TRADE_COLORS[p.trade] || '#94a3b8',
                              }}>{(p.trade || '').replace('_', ' ')}</span>
                            </td>
                            <td style={{ padding: '12px 16px', fontSize: 13,
                              color: '#22c55e', fontWeight: 600 }}>
                              {p.FINAL_VALUATION || p.final_valuation
                                ? `$${(p.FINAL_VALUATION || p.final_valuation).replace(/[^0-9.]/g, '') > 0
                                    ? parseFloat((p.FINAL_VALUATION || p.final_valuation).replace(/[^0-9.]/g, '')).toLocaleString()
                                    : '—'}`
                                : '—'}
                            </td>
                            <td style={{ padding: '12px 16px', fontSize: 12, color: '#64748b' }}>
                              {p.LAST_ISSUED_DATE || p.last_issued_date || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {filteredPermits.length === 0 && (
                      <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
                        No permits found for this filter.
                      </div>
                    )}
                    {tier === 'starter' && permits.length >= 50 && (
                      <div style={{ padding: '16px 20px', background: '#1e293b',
                        borderTop: '1px solid #1e293b', display: 'flex',
                        alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Lock size={14} color="#475569" />
                          <span style={{ fontSize: 12, color: '#64748b' }}>
                            {permits.length - 50} more permits available on Pro
                          </span>
                        </div>
                        <a href="/pricing" style={{ fontSize: 12, color: '#3b82f6', fontWeight: 600 }}>
                          Upgrade to Pro →
                        </a>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* TRENDS TAB */}
              {activeTab === 'trends' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {/* Trade volume chart */}
                  <div style={{ background: '#111827', border: '1px solid #1e293b',
                    borderRadius: 12, padding: '20px 24px' }}>
                    <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 700,
                      color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Permits by Trade
                    </h3>
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={tradeChartData} layout="vertical">
                        <XAxis type="number" tick={{ fontSize: 11, fill: '#475569' }} axisLine={false} tickLine={false} />
                        <YAxis dataKey="trade" type="category" tick={{ fontSize: 11, fill: '#94a3b8' }}
                          axisLine={false} tickLine={false} width={100} />
                        <Tooltip
                          contentStyle={{ background: '#1e293b', border: '1px solid #334155',
                            borderRadius: 8, fontSize: 12 }}
                          cursor={{ fill: '#ffffff08' }}
                        />
                        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                          {tradeChartData.map((entry, i) => (
                            <Cell key={i} fill={entry.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Top zip codes */}
                  <div style={{ background: '#111827', border: '1px solid #1e293b',
                    borderRadius: 12, padding: '20px 24px' }}>
                    <h3 style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 700,
                      color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Hottest ZIP Codes
                    </h3>
                    {summary.targeting?.top_zips?.map((z: any, i: number) => (
                      <div key={z.zip} style={{ display: 'flex', alignItems: 'center',
                        justifyContent: 'space-between', padding: '10px 0',
                        borderBottom: i < summary.targeting.top_zips.length - 1
                          ? '1px solid #1e293b' : 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6',
                            width: 20, textAlign: 'center' }}>#{i + 1}</span>
                          <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
                            {z.zip}
                          </span>
                        </div>
                        <span style={{ fontSize: 13, color: '#64748b' }}>{z.count} permits</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* INSIGHTS TAB */}
              {activeTab === 'insights' && isPreview && (
                <PreviewLock compact />
              )}
              {activeTab === 'insights' && !isPreview && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {summary.insights?.map((insight: string, i: number) => (
                    <div key={i} style={{
                      background: '#111827', border: '1px solid #1e293b',
                      borderRadius: 10, padding: '16px 20px',
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                    }}>
                      <Star size={16} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
                      <p style={{ margin: 0, fontSize: 14, color: '#e2e8f0', lineHeight: 1.6 }}>
                        {insight}
                      </p>
                    </div>
                  ))}

                  {/* Top opportunity */}
                  {summary.targeting?.top_opportunity?.address && (
                    <div style={{
                      background: 'linear-gradient(135deg, #14532d20, #0f172a)',
                      border: '1px solid #22c55e40', borderRadius: 12,
                      padding: '20px 24px', marginTop: 8,
                    }}>
                      <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 700,
                        textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
                        🎯 Top Opportunity This Week
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9',
                        marginBottom: 4 }}>
                        {summary.targeting.top_opportunity.address}
                      </div>
                      <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#64748b' }}>
                        <span>{summary.targeting.top_opportunity.type}</span>
                        <span style={{ color: '#22c55e' }}>
                          Score: {summary.targeting.top_opportunity.score}/100
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {upgrade && (
        <UpgradeModal
          trigger={upgrade.trigger}
          countyKey={upgrade.county?.key}
          countyLabel={upgrade.county?.label}
          countyCount={upgrade.county?.count}
          tier={tier}
          limits={limits}
          userId={user?.id}
          getToken={getToken}
          onClose={() => setUpgrade(null)}
        />
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
        * { box-sizing: border-box; }
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0f1e; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
      `}</style>
    </div>
  );
}
