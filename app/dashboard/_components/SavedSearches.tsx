'use client';

// Device-local Saved Searches control (v1). Lives in the Permits tab beside the filter/sort
// controls it captures. Persists ONLY to localStorage (see lib/savedSearches) — it does NOT sync
// across devices, adds no fetch, and touches no entitlement/Clerk/Stripe. Applying re-checks the
// saved county against current entitlement and never applies a county the user no longer has.
//
// Distinct from the existing "Saved" tab (SavedLeads = server-backed saved permit leads).

import { useEffect, useState } from 'react';
import { Bookmark, Trash2 } from 'lucide-react';
import type { SortOption } from '../../../lib/sort';
import {
  type SavedSearch,
  MAX_NAME_LENGTH,
  loadSavedSearches, saveSavedSearches,
  createSavedSearch, deleteSavedSearch,
  validateSavedSearchName, resolveSavedSearchCounty, toAppliedState,
} from '../../../lib/savedSearches';

interface CurrentState {
  county: string;
  tradeFilter: string;
  search: string;
  sortOption: SortOption;
}

export default function SavedSearches({
  current, counties, tier, allowedCounties, onApply,
}: {
  current: CurrentState;
  counties: { key: string }[];
  tier: string;
  allowedCounties: string[];
  onApply: (next: CurrentState) => void;
}) {
  const [list, setList]     = useState<SavedSearch[]>([]);
  const [name, setName]     = useState('');
  const [error, setError]   = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null); // inline delete confirmation

  // Load once on mount (client-only — never during SSR).
  useEffect(() => { setList(loadSavedSearches()); }, []);

  const persist = (next: SavedSearch[]) => { setList(next); saveSavedSearches(next); };

  const handleSave = () => {
    const v = validateSavedSearchName(name);
    if (v.error) { setError(v.error); return; }
    const created = createSavedSearch({ name: v.value, ...currentInput() });
    persist([...list, created]);
    setName(''); setError(null); setNotice(null);
  };

  const currentInput = () => ({
    county: current.county, tradeFilter: current.tradeFilter,
    search: current.search, sortOption: current.sortOption,
  });

  const handleApply = (s: SavedSearch) => {
    const resolved = resolveSavedSearchCounty(s, counties, tier, allowedCounties);
    const applied = toAppliedState(s);
    onApply({
      county: resolved.county,
      tradeFilter: applied.tradeFilter,
      search: applied.search,
      sortOption: applied.sortOption,
    });
    setNotice(resolved.countyChanged
      ? `"${s.name}": its saved county is no longer included in your plan, so it was not applied.`
      : null);
  };

  const handleDelete = (id: string) => { persist(deleteSavedSearch(list, id)); setNotice(null); setConfirmingId(null); };

  const chip = (label: string) => (
    <span style={{
      fontSize: 10, color: '#64748b', background: '#0d1529', border: '1px solid #1e293b',
      borderRadius: 6, padding: '1px 6px', textTransform: 'capitalize', whiteSpace: 'nowrap',
    }}>{label}</span>
  );

  return (
    <div style={{
      background: '#0d1529', border: '1px solid #1e293b', borderRadius: 10,
      padding: '12px 14px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Bookmark size={14} color="#93c5fd" />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>Saved searches</span>
        <span style={{ fontSize: 10, color: '#475569' }}>this browser only</span>
      </div>

      {/* Save the current configuration */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: list.length ? 12 : 0 }}>
        <input
          value={name}
          maxLength={MAX_NAME_LENGTH}
          onChange={e => { setName(e.target.value); if (error) setError(null); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }}
          placeholder="Name this search…"
          aria-label="Saved search name"
          style={{
            flex: 1, minWidth: 200, padding: '7px 10px', borderRadius: 8, fontSize: 12,
            background: '#111827', border: `1px solid ${error ? '#7f1d1d' : '#1e293b'}`, color: '#e2e8f0', outline: 'none',
          }}
        />
        <button
          onClick={handleSave}
          disabled={!name.trim()}
          aria-label="Save current search"
          style={{
            padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
            cursor: name.trim() ? 'pointer' : 'not-allowed',
            background: name.trim() ? '#1e3a5f' : 'transparent',
            border: `1px solid ${name.trim() ? '#2563eb' : '#1e293b'}`,
            color: name.trim() ? '#93c5fd' : '#475569',
          }}>
          Save current
        </button>
      </div>

      {error && <div role="alert" style={{ fontSize: 11, color: '#f87171', marginBottom: 8 }}>{error}</div>}
      {notice && <div role="status" style={{ fontSize: 11, color: '#fbbf24', marginBottom: 8 }}>{notice}</div>}

      {/* Saved list */}
      {list.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map(s => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              padding: '7px 10px', background: '#111827', border: '1px solid #1e293b', borderRadius: 8,
            }}>
              <button
                onClick={() => handleApply(s)}
                aria-label={`Apply saved search ${s.name}`}
                style={{
                  flex: 1, minWidth: 140, textAlign: 'left', background: 'transparent', border: 'none',
                  cursor: 'pointer', color: '#e2e8f0', fontSize: 12, fontWeight: 600, padding: 0,
                }}>
                {s.name}
              </button>
              {chip(s.county.replace(/_/g, ' ') || '—')}
              {chip(s.tradeFilter ? s.tradeFilter.replace(/_/g, ' ') : 'all trades')}
              {confirmingId === s.id ? (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <button
                    onClick={() => setConfirmingId(null)}
                    aria-label="Cancel delete"
                    style={{ background: 'transparent', border: '1px solid #334155', borderRadius: 6,
                      padding: '3px 9px', fontSize: 11, fontWeight: 600, color: '#94a3b8', cursor: 'pointer' }}>
                    Cancel
                  </button>
                  <button
                    onClick={() => handleDelete(s.id)}
                    aria-label={`Confirm delete saved search ${s.name}`}
                    style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: 6,
                      padding: '3px 9px', fontSize: 11, fontWeight: 700, color: '#fecaca', cursor: 'pointer' }}>
                    Delete
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmingId(s.id)}
                  aria-label={`Delete saved search ${s.name}`}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#475569', padding: 2, display: 'inline-flex' }}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
