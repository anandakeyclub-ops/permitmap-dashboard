'use client';

// P4 Onboarding page — a paying customer explicitly selects the counties + trades they want
// permits for. Selections persist to Clerk publicMetadata via the saveOnboardingSelections server
// action (which enforces the tier limit + canonical taxonomy SERVER-SIDE). Already-saved selections
// are pre-checked so leaving and returning resumes where they left off. On completion → dashboard.

import { useEffect, useMemo, useState } from 'react';
import { useUser, useAuth } from '@clerk/nextjs';
import { apiFetch } from '../../lib/api';
import { SUPPORTED_TRADES, entitlementCountyLimit, ALL_COUNTY_TIERS, migrateLegacySelectedCounties } from '../../lib/onboarding';
import { saveOnboardingSelections } from '../actions';

interface CountyOpt { key: string; label: string; count?: number }

export default function OnboardingPage() {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const tier = (user?.publicMetadata?.tier as string) || 'preview';
  const limit = entitlementCountyLimit(tier);
  const allCounties = ALL_COUNTY_TIERS.has(tier);
  const monthlyPrice: Record<string, number> = { starter: 79, pro: 149, team: 299 };

  const [counties, setCounties] = useState<CountyOpt[]>([]);
  const [selCounties, setSelCounties] = useState<string[]>([]);
  const [selTrades, setSelTrades] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  // Pre-fill from existing selections (resume) once the user is loaded.
  useEffect(() => {
    if (!isLoaded || !user) return;
    setSelCounties(migrateLegacySelectedCounties(user.publicMetadata as any));
    setSelTrades((user.publicMetadata?.selected_trades as string[]) || []);
  }, [isLoaded, user]);

  // Canonical county options from the API (authoritative slugs).
  useEffect(() => {
    apiFetch('/counties', getToken)
      .then((r: any) => r.json())
      .then((d: any) => setCounties((d?.counties || []).filter((c: CountyOpt) => c.key)))
      .catch(() => setCounties([]));
  }, [getToken]);

  const atCountyLimit = !allCounties && selCounties.length >= limit;
  const canSubmit = useMemo(
    () => (allCounties || selCounties.length >= 1) && selTrades.length >= 1 && !saving,
    [allCounties, selCounties, selTrades, saving]);

  function toggleCounty(key: string) {
    setSelCounties((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key)
        : atCountyLimit ? cur                         // client hint; server enforces authoritatively
          : [...cur, key]);
  }
  function toggleTrade(t: string) {
    setSelTrades((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  async function submit() {
    setSaving(true); setErrors([]);
    try {
      const res = await saveOnboardingSelections({ counties: selCounties, trades: selTrades });
      if (res.ok && res.complete) { setDone(true); window.location.href = '/dashboard'; return; }
      setErrors(res.errors.length ? res.errors : ['could_not_complete']);
    } catch {
      setErrors(['save_failed']);
    } finally {
      setSaving(false);
    }
  }

  if (!isLoaded) return <main style={{ padding: 24 }}>Loading…</main>;
  if (!['starter', 'pro', 'team'].includes(tier)) {
    return <main style={{ padding: 24 }}>An active plan is required to configure delivery. <a href="/pricing">See plans</a>.</main>;
  }

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1>Choose what PermitMap should deliver</h1>
      <p>Your <strong style={{ textTransform: 'capitalize' }}>{tier}</strong> plan includes{' '}
        {allCounties ? 'every supported county' : `up to ${limit} count${limit === 1 ? 'y' : 'ies'}`}.
        Choose the markets and trades you actually work. You can change these later.</p>

      <section aria-label="Subscription expectations" style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12,
        padding: '16px 18px', margin: '20px 0', lineHeight: 1.55,
      }}>
        <strong>What happens next</strong>
        <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li>We configure your dashboard and ranked opportunity queue.</li>
          <li>Your permit summary arrives by email each week; the dashboard holds the full workflow.</li>
          <li>Your 14-day trial automatically converts to <strong>${monthlyPrice[tier]}/month</strong> unless you cancel before it ends.</li>
        </ol>
      </section>

      {!allCounties && (
        <section aria-labelledby="counties-h">
          <h2 id="counties-h">Counties {`(${selCounties.length}/${limit})`}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {counties.map((c) => {
              const on = selCounties.includes(c.key);
              return (
                <label key={c.key} style={{ opacity: !on && atCountyLimit ? 0.5 : 1 }}>
                  <input type="checkbox" checked={on} disabled={!on && atCountyLimit} onChange={() => toggleCounty(c.key)} />
                  {' '}{c.label || c.key}
                </label>
              );
            })}
            {counties.length === 0 && <span>Loading counties…</span>}
          </div>
        </section>
      )}

      <section aria-labelledby="trades-h">
        <h2 id="trades-h">Trades</h2>
        <p style={{ marginTop: -8, color: '#475569' }}>Select at least one so your dashboard and weekly delivery prioritize relevant work.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {SUPPORTED_TRADES.map((t) => (
            <label key={t}>
              <input type="checkbox" checked={selTrades.includes(t)} onChange={() => toggleTrade(t)} />
              {' '}{t.replace(/_/g, ' ')}
            </label>
          ))}
        </div>
      </section>

      {errors.length > 0 && (
        <p role="alert" style={{ color: '#b00' }}>Please fix: {errors.join(', ')}</p>
      )}

      <button onClick={submit} disabled={!canSubmit} aria-disabled={!canSubmit}
        style={{ marginTop: 16, padding: '10px 16px' }}>
        {saving ? 'Saving…' : done ? 'Saved' : 'Activate my permit delivery'}
      </button>
    </main>
  );
}
