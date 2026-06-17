'use client';

import { useState } from 'react';
import { Target, MapPin, Clock, DollarSign, Flame, TrendingUp, ChevronRight } from 'lucide-react';

// ── Phase A: "Best Opportunities This Week" — ranked pursuit queue + explainability.
// Data source: /permits/scored (already sorted by score desc, score>=50, tier-capped).
// No new API: the "Why this opportunity?" chips are derived from the SAME inputs the
// API scorer uses (project value, recency, trade demand) plus the hot-ZIP signal that
// already ships in /summary -> targeting.top_zips.

const TRADE_COLORS: Record<string, string> = {
  roofing: '#ef4444', hvac: '#f97316', electrical: '#eab308', plumbing: '#3b82f6',
  pool: '#06b6d4', solar: '#22c55e', general_contractor: '#8b5cf6',
};
// Trades the API scorer weights highest (>=14 pts) — i.e. strongest demand signal.
const HIGH_DEMAND = new Set(['roofing', 'hvac', 'pool', 'solar']);

const scoreColor = (s: number) =>
  s >= 80 ? '#22c55e' : s >= 60 ? '#f97316' : s >= 40 ? '#eab308' : '#6b7280';

function parseVal(v: any): number {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? 0 : n;
}
function fmtVal(v: any): string {
  const n = parseVal(v);
  return n > 0 ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—';
}
// Days since LAST_ISSUED_DATE; null if unparseable. Mirrors the API recency input.
function ageDays(raw: any): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  return diff < 0 ? 0 : diff;
}
function fmtAge(raw: any): string {
  const a = ageDays(raw);
  if (a === null) return '—';
  if (a === 0) return 'today';
  if (a === 1) return '1 day ago';
  return `${a} days ago`;
}

type Reason = { icon: any; label: string; sub?: string };

// Derive "Why this opportunity?" from existing fields + the hot-ZIP set from /summary.
function deriveReasons(p: any, hotZips: Set<string>): Reason[] {
  const reasons: Reason[] = [];
  const val = parseVal(p.FINAL_VALUATION ?? p.final_valuation);
  if (val >= 50000) reasons.push({ icon: DollarSign, label: 'High project value', sub: fmtVal(val) });
  else if (val >= 25000) reasons.push({ icon: DollarSign, label: 'Above-average value', sub: fmtVal(val) });

  const age = ageDays(p.LAST_ISSUED_DATE ?? p.last_issued_date);
  if (age !== null && age <= 7) reasons.push({ icon: Clock, label: 'Recently filed', sub: fmtAge(p.LAST_ISSUED_DATE ?? p.last_issued_date) });

  const trade = (p.trade || '').toLowerCase();
  if (HIGH_DEMAND.has(trade)) reasons.push({ icon: TrendingUp, label: 'High-demand trade' });

  const zip = String(p.ZIP ?? p.zip ?? '').trim();
  if (zip && hotZips.has(zip)) reasons.push({ icon: Flame, label: 'Hot ZIP code', sub: zip });

  // Always give the contractor at least one reason so "why" is never blank.
  if (reasons.length === 0) {
    reasons.push({ icon: Target, label: `${(trade || 'permit').replace('_', ' ')} match`, sub: `score ${p.score}` });
  }
  return reasons;
}

function ReasonChip({ r }: { r: Reason }) {
  const Icon = r.icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: '#0d1529', border: '1px solid #1e293b', borderRadius: 20,
      padding: '4px 10px', fontSize: 12, color: '#cbd5e1', textTransform: 'capitalize',
    }}>
      <Icon size={12} color="#60a5fa" />
      {r.label}{r.sub ? <span style={{ color: '#64748b' }}>· {r.sub}</span> : null}
    </span>
  );
}

function ScoreBadge({ score, size = 44 }: { score: number; size?: number }) {
  const c = scoreColor(score);
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: '50%',
      background: `${c}20`, border: `2px solid ${c}`,
      fontSize: size > 40 ? 16 : 13, fontWeight: 700, color: c, flexShrink: 0,
    }}>{score}</div>
  );
}

export default function CallList({ scored, topZips }: { scored: any[]; topZips: string[] }) {
  const [tradeFilter, setTradeFilter] = useState('');
  const hotZips = new Set((topZips || []).map(z => String(z).trim()));

  const list = (scored || []).filter(p => !tradeFilter || (p.trade || '').toLowerCase() === tradeFilter);
  const hero = list[0];
  const rest = list.slice(1);

  return (
    <div>
      {/* Section header — outcome-oriented */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Target size={20} color="#22c55e" />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
          Best Opportunities This Week
        </h2>
      </div>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: '#64748b' }}>
        {list.length} scored {list.length === 1 ? 'opportunity' : 'opportunities'}, ranked by priority —
        start at the top.
      </p>

      {/* Trade filter */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {['', 'roofing', 'hvac', 'electrical', 'plumbing', 'pool', 'solar', 'general_contractor'].map(t => (
          <button key={t} onClick={() => setTradeFilter(t)} style={{
            padding: '5px 12px', borderRadius: 20,
            border: `1px solid ${tradeFilter === t ? (TRADE_COLORS[t] || '#3b82f6') : '#1e293b'}`,
            background: tradeFilter === t ? `${TRADE_COLORS[t] || '#2563eb'}20` : 'transparent',
            color: tradeFilter === t ? (TRADE_COLORS[t] || '#3b82f6') : '#64748b',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
          }}>{t ? t.replace('_', ' ') : 'All Trades'}</button>
        ))}
      </div>

      {!hero ? (
        <div style={{ padding: 48, textAlign: 'center', color: '#475569',
          background: '#111827', border: '1px solid #1e293b', borderRadius: 12 }}>
          No scored opportunities for this {tradeFilter ? 'trade' : 'county'} this week.
        </div>
      ) : (
        <>
          {/* HERO — Call first */}
          <div style={{
            background: 'linear-gradient(135deg, #14532d20 0%, #0d1529 100%)',
            border: '1px solid #22c55e55', borderRadius: 14, padding: '22px 26px', marginBottom: 20,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#22c55e',
                textTransform: 'uppercase', letterSpacing: '0.1em' }}>★ Pursue first</span>
            </div>
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
              <ScoreBadge score={hero.score} size={56} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 19, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>
                  {hero.FULL_ADDRESS || hero.full_address || '—'}
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13,
                  color: '#94a3b8', marginBottom: 6 }}>
                  {(hero.OWNER_NAME || hero.owner_name) &&
                    <span>Owner: <span style={{ color: '#e2e8f0' }}>{hero.OWNER_NAME || hero.owner_name}</span></span>}
                  <span style={{ textTransform: 'capitalize',
                    color: TRADE_COLORS[(hero.trade || '').toLowerCase()] || '#94a3b8' }}>
                    {(hero.trade || '').replace('_', ' ')}</span>
                  <span style={{ color: '#22c55e', fontWeight: 600 }}>{fmtVal(hero.FINAL_VALUATION ?? hero.final_valuation)}</span>
                  <span><Clock size={12} style={{ verticalAlign: 'middle' }} /> {fmtAge(hero.LAST_ISSUED_DATE ?? hero.last_issued_date)}</span>
                  {(hero.ZIP || hero.zip) && <span><MapPin size={12} style={{ verticalAlign: 'middle' }} /> {hero.ZIP || hero.zip}</span>}
                </div>
                {(hero.PERMIT_DESCRIPTION || hero.permit_description) && (
                  <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                    {hero.PERMIT_DESCRIPTION || hero.permit_description}
                  </div>
                )}
                <div style={{ fontSize: 11, fontWeight: 700, color: '#475569',
                  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                  Why this opportunity?
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {deriveReasons(hero, hotZips).map((r, i) => <ReasonChip key={i} r={r} />)}
                </div>
              </div>
            </div>
          </div>

          {/* Ranked rest */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rest.map((p, i) => (
              <div key={p.PERMITNO || i} style={{
                background: '#111827', border: '1px solid #1e293b', borderRadius: 12,
                padding: '14px 18px', display: 'flex', gap: 16, alignItems: 'flex-start',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, color: '#475569', fontWeight: 700 }}>#{i + 2}</span>
                  <ScoreBadge score={p.score} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>
                      {p.FULL_ADDRESS || p.full_address || '—'}
                    </span>
                    {(p.OWNER_NAME || p.owner_name) &&
                      <span style={{ fontSize: 12, color: '#64748b' }}>Owner: {p.OWNER_NAME || p.owner_name}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
                    <span style={{ textTransform: 'capitalize',
                      color: TRADE_COLORS[(p.trade || '').toLowerCase()] || '#94a3b8' }}>
                      {(p.trade || '').replace('_', ' ')}</span>
                    <span style={{ color: '#22c55e', fontWeight: 600 }}>{fmtVal(p.FINAL_VALUATION ?? p.final_valuation)}</span>
                    <span>{fmtAge(p.LAST_ISSUED_DATE ?? p.last_issued_date)}</span>
                    {(p.ZIP || p.zip) && <span>ZIP {p.ZIP || p.zip}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {deriveReasons(p, hotZips).map((r, j) => <ReasonChip key={j} r={r} />)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
