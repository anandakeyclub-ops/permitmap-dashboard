'use client';

// Read-only Contractor Profile panel (v1). Aggregates ONLY the permits array it is handed —
// the currently-selected county's already-loaded permits — via lib/contractorProfile. No fetch,
// no cross-county data, no entitlement logic. Reuses the permit drawer's overlay pattern
// (overlay-click + Escape + X close, focus-in on open, role="dialog"). Rendered INSTEAD of the
// Permit Detail Drawer (never alongside it) so only one modal overlay is ever active.

import { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { buildContractorProfile, formatMoney } from '../../../lib/contractorProfile';
import { handleDialogTab } from '../../../lib/dialogFocus';

export default function ContractorProfile({
  contractor, county, permits, onClose,
}: {
  contractor: string;
  county: string;
  permits: Record<string, any>[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const data = useMemo(
    () => buildContractorProfile(permits, contractor, county),
    [permits, contractor, county],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      handleDialogTab(panelRef.current, e); // trap Tab/Shift+Tab within the profile
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus(); // move focus into the profile on open
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!data) return null; // empty contractor name → no profile (parent guards too)

  const label = (t: string) => (
    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.05em', paddingTop: 2 }}>{t}</div>
  );
  const value = (t: string) => (
    <div style={{ fontSize: 13, color: '#e2e8f0', wordBreak: 'break-word', lineHeight: 1.5 }}>{t}</div>
  );

  return (
    <div onClick={onClose} className="pm-contractor-overlay">
      <style>{`
        .pm-contractor-overlay { position: fixed; inset: 0; background: rgba(2,6,23,0.72);
          z-index: 1000; display: flex; align-items: stretch; justify-content: flex-end; }
        .pm-contractor-panel { background: #0d1529; border-left: 1px solid #1e293b;
          width: 100%; max-width: 480px; height: 100vh; overflow-y: auto;
          padding: 22px 24px; box-shadow: -24px 0 64px rgba(0,0,0,0.55); outline: none; }
        .pm-contractor-grid { display: grid; grid-template-columns: 150px 1fr; gap: 10px 14px; }
        @media (max-width: 640px) { .pm-contractor-panel { max-width: 100%; } }
      `}</style>
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Contractor profile"
        className="pm-contractor-panel"
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            Contractor profile
          </h2>
          <button onClick={onClose} aria-label="Close" style={{
            background: 'transparent', border: 'none', cursor: 'pointer', color: '#475569', padding: 4 }}>
            <X size={20} />
          </button>
        </div>

        {/* Aggregate summary */}
        <div className="pm-contractor-grid" style={{ marginBottom: 20 }}>
          {label('Contractor')}      {value(data.displayName)}
          {label('County')}          {value(data.county || '—')}
          {label('Permit count')}    {value(String(data.permitCount))}
          {label('Total valuation')} {value(formatMoney(data.totalValuation))}
          {label('Avg valuation')}   {value(formatMoney(data.averageValuation))}
          {label('Most recent')}     {value(data.mostRecentDate || '—')}
          {label('Trades')}          {value(
            data.trades.length ? data.trades.map(t => t.replace(/_/g, ' ')).join(', ') : '—')}
        </div>

        {/* Recent permits (newest first, capped at 10; current-county loaded permits only) */}
        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', marginBottom: 8 }}>
          Recent permits ({data.recentPermits.length})
        </div>
        {data.recentPermits.length === 0 ? (
          <div style={{ fontSize: 13, color: '#475569' }}>No permits for this contractor in the current view.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.recentPermits.map((r, i) => (
              <div key={i} style={{ padding: '10px 12px', background: '#111827',
                border: '1px solid #1e293b', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>{r.permitNumber}</span>
                  <span style={{ fontSize: 13, color: '#22c55e', fontWeight: 600, whiteSpace: 'nowrap' }}>{r.valuation}</span>
                </div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4, wordBreak: 'break-word' }}>{r.address}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: '#64748b' }}>
                  <span style={{ textTransform: 'capitalize' }}>{r.trade.replace(/_/g, ' ')}</span>
                  <span>·</span><span>{r.status}</span>
                  <span>·</span><span>{r.issueDate}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
