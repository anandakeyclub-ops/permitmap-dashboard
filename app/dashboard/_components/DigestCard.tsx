'use client';

import { useState } from 'react';
import { ClipboardList, MapPin, TrendingUp, DollarSign, Building2, ChevronRight, X } from 'lucide-react';

// ── Sprint 2 Phase B: Weekly Digest Card — a 60-second market briefing.
// Source: GET /digest (live). We render ONLY real values returned by the API:
//   - total            -> digest.total
//   - top project      -> digest.top_permits[0] (structured fields)
//   - hottest ZIP      -> parsed from digest.body_preview ("Top ZIP: 33467 (86 permits)")
//   - most active trade-> parsed from body_preview ("Most active: General Contractor")
//   - avg value        -> parsed from body_preview ("Avg value: $48,722")
// No synthetic/mocked data: if a field can't be parsed, that highlight is omitted.

function fmtVal(v: any): string {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return isNaN(n) || n <= 0 ? '' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// ISO-week key so a dismissal lasts the week and the card reappears next digest period.
function isoWeekKey(): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${wk}`;
}

function parseBriefing(bp: string) {
  const text = String(bp || '');
  const zipM = text.match(/Top ZIP:\s*([^\s(]+)\s*\((\d+)\s*permits?\)/i);
  const trM = text.match(/Most active:\s*([^\n\r]+)/i);
  const avgM = text.match(/Avg value:\s*(\$[\d,]+)/i);
  return {
    hottestZip: zipM ? { zip: zipM[1], count: zipM[2] } : null,
    mostActive: trM ? trM[1].trim() : null,
    avgValue: avgM ? avgM[1] : null,
  };
}

function Highlight({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <Icon size={16} color="#60a5fa" style={{ flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600, textTransform: 'capitalize',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      </div>
    </div>
  );
}

export default function DigestCard({ digest, label, county, onView }:
  { digest: any; label?: string; county: string; onView: () => void }) {

  const periodKey = isoWeekKey();
  const storeKey = `digest-dismissed:${county}:${periodKey}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return typeof window !== 'undefined' && localStorage.getItem(storeKey) === '1'; } catch { return false; }
  });

  const total = Number(digest?.total || 0);
  if (!digest || total <= 0) return null;            // graceful: no empty shell

  const { hottestZip, mostActive, avgValue } = parseBriefing(digest.body_preview);
  const top = (digest.top_permits || [])[0] || null;
  const title = `This Week in ${label || 'your market'}`;

  const dismiss = () => {
    try { localStorage.setItem(storeKey, '1'); } catch {}
    setDismissed(true);
  };

  if (dismissed) {
    return (
      <button onClick={() => setDismissed(false)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        background: '#0d1529', border: '1px solid #1e293b', borderRadius: 10,
        padding: '10px 16px', cursor: 'pointer', color: '#64748b', fontSize: 13,
        marginBottom: 20, textAlign: 'left',
      }}>
        <ClipboardList size={14} color="#60a5fa" />
        Weekly briefing — {total.toLocaleString()} permits this week
        <ChevronRight size={14} style={{ marginLeft: 'auto' }} />
      </button>
    );
  }

  return (
    <div style={{
      background: 'linear-gradient(135deg, #1e3a5f 0%, #0d1529 100%)',
      border: '1px solid #2563eb55', borderRadius: 14, padding: '20px 24px', marginBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ClipboardList size={20} color="#60a5fa" />
          <div>
            <div style={{ fontSize: 11, color: '#60a5fa', fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em' }}>Your 60-second briefing</div>
            <h2 style={{ margin: '2px 0 0', fontSize: 18, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
              {title}
            </h2>
          </div>
        </div>
        <button onClick={dismiss} aria-label="Dismiss" style={{
          background: 'transparent', border: 'none', cursor: 'pointer', color: '#475569', padding: 4 }}>
          <X size={18} />
        </button>
      </div>

      {/* Headline */}
      <div style={{ margin: '14px 0 16px' }}>
        <span style={{ fontSize: 30, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>
          {total.toLocaleString()}
        </span>
        <span style={{ fontSize: 14, color: '#94a3b8', marginLeft: 8 }}>permits this week</span>
      </div>

      {/* Highlights — only those with real parsed values render */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 16, marginBottom: top ? 16 : 4 }}>
        {mostActive && <Highlight icon={TrendingUp} label="Most active trade" value={mostActive} />}
        {hottestZip && <Highlight icon={MapPin} label="Hottest ZIP" value={`${hottestZip.zip} (${hottestZip.count})`} />}
        {avgValue && <Highlight icon={DollarSign} label="Avg project value" value={avgValue} />}
      </div>

      {/* Top project */}
      {top && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
          background: '#0d152980', border: '1px solid #1e293b', borderRadius: 10, marginBottom: 18 }}>
          <Building2 size={16} color="#22c55e" style={{ flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>Top project</div>
            <div style={{ fontSize: 13, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(top.FULL_ADDRESS || '—')}
              {fmtVal(top.FINAL_VALUATION) && <span style={{ color: '#22c55e', fontWeight: 600 }}> · {fmtVal(top.FINAL_VALUATION)}</span>}
            </div>
          </div>
        </div>
      )}

      {/* CTA → Opportunity Queue */}
      <button onClick={onView} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8,
        padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
      }}>
        View Full Opportunities <ChevronRight size={16} />
      </button>
    </div>
  );
}
