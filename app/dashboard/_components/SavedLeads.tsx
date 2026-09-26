'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bookmark, Trash2, Target } from 'lucide-react';
import {
  getSavedLeads, updateSavedLead, deleteSavedLead, type GetToken,
} from '../../../lib/api';
import type { SavedLead, SavedLeadStatus } from '../../../lib/types';

// Phase C — Saved tab. Sources the new Postgres /saved-leads model (status pipeline),
// NOT the legacy file-based /saved/_tag store. One getSavedLeads() call on open;
// all status/delete mutations go through the typed helpers from Step 2 and update
// optimistically with revert-on-error.

const STATUSES: SavedLeadStatus[] = ['saved', 'called', 'quoted', 'won', 'lost'];

const STATUS_COLOR: Record<SavedLeadStatus, string> = {
  saved:  '#64748b',   // gray
  called: '#3b82f6',   // blue
  quoted: '#f97316',   // orange
  won:    '#22c55e',   // green
  lost:   '#ef4444',   // red/muted
};

function fmtVal(v: number | null): string {
  return v && v > 0 ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—';
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return String(iso).split('T')[0];
}

function StatusPill({ status }: { status: SavedLeadStatus }) {
  const c = STATUS_COLOR[status];
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
      textTransform: 'capitalize', background: `${c}20`, color: c }}>{status}</span>
  );
}

export default function SavedLeads({ getToken, onBrowse }:
  { getToken: GetToken; onBrowse?: () => void }) {

  const [leads, setLeads]         = useState<SavedLead[]>([]);
  const [loading, setLoading]     = useState(true);
  const [locked, setLocked]       = useState(false);   // 403 fallback (preview)
  const [errored, setErrored]     = useState(false);
  const [filter, setFilter]       = useState<SavedLeadStatus | 'all'>('all');
  const [pending, setPending]     = useState<Set<string>>(new Set());
  const [toast, setToast]         = useState<{ id: number; msg: string } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null); // inline delete confirmation
  const [amountDrafts, setAmountDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<string, string>>({});

  // One fetch on open — never per-row.
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLocked(false); setErrored(false);
    getSavedLeads(getToken)
      .then(d => { if (!cancelled) setLeads(d.leads || []); })
      .catch(e => {
        if (cancelled) return;
        if (String(e?.message || e).includes('403')) setLocked(true);
        else setErrored(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [getToken]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  const notify = (msg: string) => setToast(prev => ({ id: (prev?.id ?? 0) + 1, msg }));

  // Counts are the FULL pipeline (derived from all leads), independent of the filter.
  const counts = useMemo(() => {
    const c: Record<SavedLeadStatus, number> = { saved: 0, called: 0, quoted: 0, won: 0, lost: 0 };
    for (const l of leads) c[l.status] = (c[l.status] ?? 0) + 1;
    return c;
  }, [leads]);

  // Pipeline value summary. Permit valuation stays separate from contractor-entered quote/won dollars.
  const wins = useMemo(() => {
    const won = leads.filter(l => l.status === 'won');
    const value = won.reduce((s, l) => s + (l.value || 0), 0);
    const wonRevenue = won.reduce((s, l) => s + (l.won_amount || 0), 0);
    const quotedPipeline = leads.filter(l => l.status === 'quoted')
      .reduce((s, l) => s + (l.quoted_amount || 0), 0);
    const worked = leads.filter(l => ['called', 'quoted', 'won'].includes(l.status)).length;
    const scored = won.filter(l => l.score != null);
    const avgScore = scored.length
      ? Math.round(scored.reduce((s, l) => s + (l.score as number), 0) / scored.length)
      : null;
    return { count: won.length, value, wonRevenue, quotedPipeline, worked, avgScore };
  }, [leads]);

  const visible = filter === 'all' ? leads : leads.filter(l => l.status === filter);

  const changeStatus = async (lead: SavedLead, next: SavedLeadStatus) => {
    if (next === lead.status || pending.has(lead.id)) return;
    const prevLead = lead;
    setPending(p => new Set(p).add(lead.id));
    setLeads(ls => ls.map(l => l.id === lead.id ? { ...l, status: next } : l));   // optimistic
    try {
      const result = await updateSavedLead(getToken, lead.id, next);
      setLeads(ls => ls.map(l => l.id === lead.id ? result.lead : l));
    } catch {
      setLeads(ls => ls.map(l => l.id === lead.id ? prevLead : l)); // revert full row
      notify('Failed to update status — try again');
    } finally {
      setPending(p => { const n = new Set(p); n.delete(lead.id); return n; });
    }
  };

  const saveAmount = async (lead: SavedLead, field: 'quoted_amount' | 'won_amount', raw: string) => {
    const draftKey = `${lead.id}:${field}`;
    const cleaned = raw.replace(/[$,]/g, '').trim();
    const amount = cleaned === '' ? null : Number(cleaned);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      setAmountDrafts(d => ({ ...d, [draftKey]: lead[field] == null ? '' : String(lead[field]) }));
      notify('Enter a valid non-negative dollar amount'); return;
    }
    const prevLead = lead;
    setLeads(ls => ls.map(l => l.id === lead.id ? { ...l, [field]: amount } : l));
    try {
      const result = await updateSavedLead(getToken, lead.id, undefined, undefined, { [field]: amount });
      setLeads(ls => ls.map(l => l.id === lead.id ? result.lead : l));
      setAmountDrafts(d => { const n = { ...d }; delete n[draftKey]; return n; });
    } catch {
      setLeads(ls => ls.map(l => l.id === lead.id ? prevLead : l));
      setAmountDrafts(d => ({ ...d, [draftKey]: prevLead[field] == null ? '' : String(prevLead[field]) }));
      notify('Failed to save pipeline value — try again');
    }
  };

  const saveNotes = async (lead: SavedLead, raw: string) => {
    const notes = raw.trim().slice(0, 2000);
    if (notes === (lead.notes || '')) { setNoteDrafts(d => { const n={...d}; delete n[lead.id]; return n; }); return; }
    const prevLead = lead;
    setLeads(ls => ls.map(l => l.id === lead.id ? { ...l, notes: notes || null } : l));
    try {
      const result = await updateSavedLead(getToken, lead.id, undefined, notes);
      setLeads(ls => ls.map(l => l.id === lead.id ? result.lead : l));
      setNoteDrafts(d => { const n={...d}; delete n[lead.id]; return n; });
    } catch {
      setLeads(ls => ls.map(l => l.id === lead.id ? prevLead : l));
      setNoteDrafts(d => ({ ...d, [lead.id]: prevLead.notes || '' }));
      notify('Failed to save notes — try again');
    }
  };

  const followUpDate = (lead: SavedLead) => followUpDrafts[lead.id] ?? (lead.follow_up_at ? lead.follow_up_at.slice(0, 10) : '');
  const followUpState = (lead: SavedLead) => {
    const v = followUpDate(lead); if (!v) return '';
    const today = new Date(); today.setHours(0,0,0,0); const d = new Date(`${v}T00:00:00`);
    if (d.getTime() < today.getTime()) return 'Overdue';
    if (d.getTime() === today.getTime()) return 'Due today';
    return '';
  };
  const saveFollowUp = async (lead: SavedLead, raw: string) => {
    const iso = raw ? new Date(`${raw}T12:00:00`).toISOString() : null;
    const prevLead = lead;
    setLeads(ls => ls.map(l => l.id === lead.id ? { ...l, follow_up_at: iso } : l));
    try {
      const result = await updateSavedLead(getToken, lead.id, undefined, undefined, undefined, iso);
      setLeads(ls => ls.map(l => l.id === lead.id ? result.lead : l));
      setFollowUpDrafts(d => { const n={...d}; delete n[lead.id]; return n; });
    } catch {
      setLeads(ls => ls.map(l => l.id === lead.id ? prevLead : l));
      notify('Failed to schedule follow-up — try again');
    }
  };

  const remove = async (lead: SavedLead) => {
    if (pending.has(lead.id)) return;
    setConfirmingId(null); // confirmation handled inline by the row (see the delete cell)
    const snapshot = leads;
    setPending(p => new Set(p).add(lead.id));
    setLeads(ls => ls.filter(l => l.id !== lead.id));                              // optimistic
    try {
      await deleteSavedLead(getToken, lead.id);
    } catch {
      setLeads(snapshot);                                                          // revert
      notify('Failed to remove — try again');
    } finally {
      setPending(p => { const n = new Set(p); n.delete(lead.id); return n; });
    }
  };

  // ── States ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 60, flexDirection: 'column', gap: 12 }}>
        <span style={{ width: 32, height: 32, border: '3px solid #1e293b',
          borderTop: '3px solid #3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <span style={{ color: '#475569', fontSize: 13 }}>Loading saved leads…</span>
      </div>
    );
  }

  if (locked) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#cbd5e1',
        background: '#111827', border: '1px solid #f59e0b40', borderRadius: 12 }}>
        Saved leads are a paid feature. Start a 14-day trial to track opportunities through your pipeline.
      </div>
    );
  }

  if (errored) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#ef4444',
        background: '#111827', border: '1px solid #1e293b', borderRadius: 12 }}>
        Couldn’t load your saved leads. Please try again.
      </div>
    );
  }

  if (leads.length === 0) {
    return (
      <div style={{ padding: 48, textAlign: 'center', background: '#111827',
        border: '1px solid #1e293b', borderRadius: 12 }}>
        <Bookmark size={28} color="#475569" style={{ marginBottom: 12 }} />
        <p style={{ margin: '0 0 16px', color: '#94a3b8', fontSize: 14 }}>
          No saved leads yet. Save opportunities from Best Opportunities This Week.
        </p>
        {onBrowse && (
          <button onClick={onBrowse} style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            background: '#34d399', color: '#062018', border: 'none', borderRadius: 8,
            padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            <Target size={15} /> Browse opportunities
          </button>
        )}
      </div>
    );
  }

  // ── Pipeline + list ─────────────────────────────────────────────────────────
  const Pill = ({ label, value, active, color, onClick }:
    { label: string; value: number; active: boolean; color: string; onClick: () => void }) => (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px',
      borderRadius: 20, cursor: 'pointer', fontSize: 13, fontWeight: 600,
      textTransform: 'capitalize',
      border: `1px solid ${active ? color : '#1e293b'}`,
      background: active ? `${color}20` : 'transparent',
      color: active ? color : '#94a3b8',
    }}>
      {label}
      <span style={{ fontSize: 12, fontWeight: 700, color: active ? color : '#64748b' }}>{value}</span>
    </button>
  );

  return (
    <div>
      <style>{`
        .pm-saved-mobile { display: none; }
        @media (max-width: 720px) {
          .pm-saved-table { display: none; }
          .pm-saved-mobile { display: flex; flex-direction: column; gap: 10px; }
        }
      `}</style>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
        Saved Leads
      </h2>
      <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>
        {leads.length} saved {leads.length === 1 ? 'lead' : 'leads'} — track each through your pipeline.
      </p>

      {/* Pipeline summary — clickable status filters (client-side; no extra fetch) */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <Pill label="all" value={leads.length} active={filter === 'all'} color="#3b82f6"
          onClick={() => setFilter('all')} />
        {STATUSES.map(s => (
          <Pill key={s} label={s} value={counts[s]} active={filter === s} color={STATUS_COLOR[s]}
            onClick={() => setFilter(s)} />
        ))}
      </div>

      <div className="pm-saved-table" style={{ background: '#111827', border: '1px solid #1e293b', borderRadius: 12, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 920 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #1e293b' }}>
              {['Address', 'Trade', 'Permit Value', 'Quote / Won $', 'Permit Date', 'Score', 'Status', 'Follow up', 'Notes', ''].map(h => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11,
                  color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((l, i) => {
              const busy = pending.has(l.id);
              return (
                <tr key={l.id} style={{ borderBottom: '1px solid #0f172a',
                  background: i % 2 === 0 ? '#111827' : '#0d1529', opacity: busy ? 0.6 : 1 }}>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#e2e8f0', maxWidth: 240,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.address || '—'}
                    <div style={{ fontSize: 11, color: '#475569' }}>{l.county}</div>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 12, color: '#94a3b8',
                    textTransform: 'capitalize' }}>{(l.trade || '—').replace('_', ' ')}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#94a3b8', fontWeight: 600 }}>
                    {fmtVal(l.value)}</td>
                  <td style={{ padding: '12px 16px', minWidth: 155 }}>
                    {(l.status === 'quoted' || l.status === 'won') ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#64748b' }}>
                        {l.status === 'won' ? 'Won' : 'Quote'} $
                        <input type="number" min="0" step="1"
                          value={amountDrafts[`${l.id}:${l.status === 'won' ? 'won_amount' : 'quoted_amount'}`]
                            ?? String((l.status === 'won' ? l.won_amount : l.quoted_amount) ?? '')}
                          onChange={e => setAmountDrafts(d => ({ ...d,
                            [`${l.id}:${l.status === 'won' ? 'won_amount' : 'quoted_amount'}`]: e.target.value }))}
                          onBlur={e => saveAmount(l, l.status === 'won' ? 'won_amount' : 'quoted_amount', e.target.value)}
                          style={{ width: 88, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155',
                            borderRadius: 5, padding: '4px 6px', fontSize: 12 }} />
                      </label>
                    ) : <span style={{ color: '#334155' }}>—</span>}
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 12, color: '#64748b' }}>{fmtDate(l.permit_date)}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: '#94a3b8' }}>{l.score ?? '—'}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <select
                      value={l.status}
                      disabled={busy}
                      onChange={e => changeStatus(l, e.target.value as SavedLeadStatus)}
                      aria-label="Change status"
                      style={{
                        appearance: 'none', WebkitAppearance: 'none',
                        background: `${STATUS_COLOR[l.status]}20`, color: STATUS_COLOR[l.status],
                        border: `1px solid ${STATUS_COLOR[l.status]}`, borderRadius: 6,
                        padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
                        textTransform: 'capitalize',
                      }}>
                      {STATUSES.map(s => <option key={s} value={s} style={{ background: '#0d1529', color: '#e2e8f0' }}>{s}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '12px 16px', minWidth: 145 }}>
                    <input type="date" value={followUpDate(l)} aria-label={`Follow up for ${l.address || l.county}`}
                      onChange={e => { setFollowUpDrafts(d => ({...d,[l.id]:e.target.value})); saveFollowUp(l,e.target.value); }}
                      style={{ background:'#0f172a',color:'#e2e8f0',border:'1px solid #334155',borderRadius:5,padding:'5px 6px',fontSize:12 }} />
                    {followUpState(l) && <div style={{ marginTop:4,fontSize:10,fontWeight:700,color:followUpState(l)==='Overdue'?'#f87171':'#facc15' }}>{followUpState(l)}</div>}
                  </td>
                  <td style={{ padding: '12px 16px', minWidth: 190 }}>
                    <input
                      value={noteDrafts[l.id] ?? l.notes ?? ''}
                      maxLength={2000}
                      placeholder="Call notes / next step"
                      aria-label={`Notes for ${l.address || l.county}`}
                      onChange={e => setNoteDrafts(d => ({ ...d, [l.id]: e.target.value }))}
                      onBlur={e => saveNotes(l, e.target.value)}
                      style={{ width: '100%', minWidth: 160, boxSizing: 'border-box', background: '#0f172a',
                        color: '#e2e8f0', border: '1px solid #334155', borderRadius: 5, padding: '5px 7px', fontSize: 12 }} />
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    {confirmingId === l.id ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                        <button onClick={() => setConfirmingId(null)} disabled={busy} aria-label="Cancel remove"
                          style={{ background: 'transparent', border: '1px solid #334155', borderRadius: 6,
                            padding: '4px 10px', fontSize: 12, fontWeight: 600, color: '#94a3b8',
                            cursor: busy ? 'wait' : 'pointer' }}>
                          Cancel
                        </button>
                        <button onClick={() => remove(l)} disabled={busy}
                          aria-label={`Confirm remove saved lead ${l.address || l.county}`}
                          style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 6,
                            padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#fecaca',
                            cursor: busy ? 'wait' : 'pointer' }}>
                          Delete
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmingId(l.id)} disabled={busy} title="Remove" aria-label="Remove saved lead"
                        style={{ background: 'transparent', border: 'none', cursor: busy ? 'wait' : 'pointer',
                          color: '#64748b', padding: 4 }}>
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: '#475569', fontSize: 13 }}>
            No leads with status “{filter}”.
          </div>
        )}
      </div>

      <div className="pm-saved-mobile">
        {visible.map(l => (
          <div key={l.id} style={{ background: '#111827', border: '1px solid #1e293b', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 700, marginBottom: 3 }}>{l.address || 'Address unavailable'}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, textTransform: 'capitalize' }}>
              {l.county} · {(l.trade || 'trade unavailable').replace('_', ' ')} · {fmtDate(l.permit_date)}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <select value={l.status} disabled={pending.has(l.id)} onChange={e => changeStatus(l, e.target.value as SavedLeadStatus)}
                aria-label="Change status" style={{ flex: 1, background: '#0f172a', color: STATUS_COLOR[l.status], border: '1px solid #334155', borderRadius: 6, padding: '7px 8px' }}>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>Score {l.score ?? '—'}</span>
            </div>
            {(l.status === 'quoted' || l.status === 'won') && (
              <label style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 10 }}>
                {l.status === 'won' ? 'Won revenue' : 'Quote'} $
                <input type="number" min="0" step="1"
                  value={amountDrafts[`${l.id}:${l.status === 'won' ? 'won_amount' : 'quoted_amount'}`] ?? String((l.status === 'won' ? l.won_amount : l.quoted_amount) ?? '')}
                  onChange={e => setAmountDrafts(d => ({ ...d, [`${l.id}:${l.status === 'won' ? 'won_amount' : 'quoted_amount'}`]: e.target.value }))}
                  onBlur={e => saveAmount(l, l.status === 'won' ? 'won_amount' : 'quoted_amount', e.target.value)}
                  style={{ marginLeft: 5, width: 110, background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 5, padding: '5px 7px' }} />
              </label>
            )}
            <label style={{ display:'block',fontSize:11,color:'#64748b',marginBottom:10 }}>Follow up
              <input type="date" value={followUpDate(l)} aria-label={`Follow up for ${l.address || l.county}`}
                onChange={e => { setFollowUpDrafts(d=>({...d,[l.id]:e.target.value})); saveFollowUp(l,e.target.value); }}
                style={{ display:'block',marginTop:4,width:'100%',boxSizing:'border-box',background:'#0f172a',color:'#e2e8f0',border:'1px solid #334155',borderRadius:6,padding:7 }} />
              {followUpState(l) && <strong style={{ display:'block',marginTop:4,color:followUpState(l)==='Overdue'?'#f87171':'#facc15' }}>{followUpState(l)}</strong>}
            </label>
            <textarea value={noteDrafts[l.id] ?? l.notes ?? ''} maxLength={2000} rows={2}
              placeholder="Call notes / next step" aria-label={`Notes for ${l.address || l.county}`}
              onChange={e => setNoteDrafts(d => ({ ...d, [l.id]: e.target.value }))} onBlur={e => saveNotes(l, e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', background: '#0f172a', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 6, padding: 8, fontSize: 12 }} />
          </div>
        ))}
      </div>

      {/* Contractor-entered ROI: permit value remains separate and is never presented as revenue. */}
      {(wins.worked > 0 || wins.quotedPipeline > 0 || wins.wonRevenue > 0) && (
        <div style={{ marginTop: 18, background: '#111827', border: '1px solid #2563eb50', borderRadius: 12, padding: '18px 22px' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#f1f5f9', marginBottom: 12 }}>Your PermitMap Pipeline</div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <div><div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>Worked now</div><strong>{wins.worked}</strong></div>
            <div><div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>Quoted now</div><strong>{counts.quoted}</strong></div>
            <div><div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>Won now</div><strong>{wins.count}</strong></div>
            <div><div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>Quoted pipeline</div><strong>{fmtVal(wins.quotedPipeline)}</strong></div>
            <div><div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase' }}>Won revenue</div><strong>{fmtVal(wins.wonRevenue)}</strong></div>
          </div>
        </div>
      )}

      {wins.count > 0 && (
        <div style={{ marginTop: 18,
          background: 'linear-gradient(135deg, #14532d20, #0f172a)',
          border: '1px solid #22c55e40', borderRadius: 12, padding: '18px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 20 }}>🏆</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>
              {wins.count} job{wins.count === 1 ? '' : 's'} won
            </span>
          </div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase',
                letterSpacing: '0.06em', fontWeight: 700 }}>Tracked permit value</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#22c55e' }}>{fmtVal(wins.value)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase',
                letterSpacing: '0.06em', fontWeight: 700 }}>Avg score at save</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e8f0' }}>{wins.avgScore ?? '—'}</div>
            </div>
          </div>
        </div>
      )}

      {/* Status fields not persisted in saved_leads (owner, permit description) are not shown —
          they aren't captured by POST /saved-leads. See Step 4 report. */}

      {toast && (
        <div role="status" style={{ position: 'fixed', bottom: 24, left: '50%',
          transform: 'translateX(-50%)', background: '#1e293b', color: '#f1f5f9',
          border: '1px solid #334155', borderRadius: 8, padding: '10px 18px',
          fontSize: 13, fontWeight: 600, zIndex: 1000, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
