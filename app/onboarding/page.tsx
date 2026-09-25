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

interface CountyOpt { key: string; label: string; count?: number; state?: string }
function cleanMarketName(c: CountyOpt): string {
  const base = c.key.split('_').map(x => x ? x[0].toUpperCase() + x.slice(1) : x).join(' ');
  const county = /county/i.test(c.label || '') && !/county$/i.test(base) ? ' County' : '';
  return `${base}${county}${c.state && c.state !== 'FL' ? `, ${c.state}` : ''}`;
}

export default function OnboardingPage() {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const tier = (user?.publicMetadata?.tier as string) || 'preview';
  const limit = entitlementCountyLimit(tier);
  const allCounties = ALL_COUNTY_TIERS.has(tier);
  const monthlyPrice: Record<string, number> = { starter: 79, pro: 149, team: 299 };
  const billingStatus = (user?.publicMetadata?.billing_status as string) || '';
  const isTrialing = billingStatus === 'trialing';
  const hasBillingLink = !!user?.publicMetadata?.stripe_subscription_id || !!user?.publicMetadata?.stripe_customer_id;
  // Reaching this page with a paid tier means PermitMap is configuring an already-provisioned
  // entitlement. Checkout happens before provisioning; onboarding itself must never imply/create
  // another purchase. This also covers legacy/manual tier grants that intentionally have no Stripe ids.
  const isProvisionedEntitlement = ['starter', 'pro', 'team'].includes(tier);

  const [counties, setCounties] = useState<CountyOpt[]>([]);
  const [selCounties, setSelCounties] = useState<string[]>([]);
  const [selTrades, setSelTrades] = useState<string[]>([]);
  const [countyQuery, setCountyQuery] = useState('');
  const [showAllMarkets, setShowAllMarkets] = useState(false);
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
    let cancelled = false;
    (async () => {
      try {
        // County taxonomy is public product configuration. Do not make onboarding depend on a
        // Clerk JWT template/session being accepted by the data API during an auth migration.
        const r = await apiFetch('/counties');
        if (!r.ok) throw new Error(`counties_${r.status}`);
        const d: any = await r.json();
        if (!cancelled) setCounties((d?.counties || []).filter((c: CountyOpt) => c.key));
      } catch {
        if (!cancelled) setCounties([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const atCountyLimit = !allCounties && selCounties.length >= limit;
  const visibleCounties = useMemo(() => {
    const q = countyQuery.trim().toLowerCase();
    const rows = q ? counties.filter(c => cleanMarketName(c).toLowerCase().includes(q)) : counties;
    return (q || showAllMarkets) ? rows : rows.slice(0, 12);
  }, [counties, countyQuery, showAllMarkets]);
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
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '48px 24px 72px', color: '#f8fafc', fontFamily: 'Geist, Inter, system-ui, sans-serif', background: '#090d0c', minHeight: '100vh' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:16, marginBottom:30, paddingBottom:18, borderBottom:'1px solid #23312d' }}>
        <a href="https://permitmap.org" style={{ display:'flex', alignItems:'center', gap:10, textDecoration:'none', color:'#f8fafc', fontSize:20, fontWeight:700 }}>
          <svg width="30" height="34" viewBox="0 0 28 34" fill="none" aria-hidden="true"><path d="M14 1C6.82 1 1 6.82 1 14c0 9.2 13 19 13 19s13-9.8 13-19C27 6.82 21.18 1 14 1Z" stroke="#34d399" strokeWidth="2"/><rect x="9" y="8" width="10" height="12" rx="1" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11h6M11 14h6M11 17h4" stroke="currentColor" strokeLinecap="round"/></svg>
          <span>Permit<span style={{color:'#34d399'}}>Map</span></span>
        </a>
        <span style={{ color:'#64748b', fontSize:12 }}>Construction Intelligence</span>
      </div>
      <div style={{ color: '#34d399', fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', marginBottom: 8 }}>PermitMap workspace setup</div>
      <h1 style={{ fontSize: 42, letterSpacing: '-.035em', margin: '0 0 12px' }}>Choose what PermitMap should deliver</h1>
      <p style={{ color:'var(--pm-text-secondary)', maxWidth:760, lineHeight:1.65 }}>Your <strong style={{ textTransform: 'capitalize', color:'var(--pm-text-primary)' }}>{tier}</strong> plan includes{' '}
        {allCounties ? 'every supported county' : `up to ${limit} count${limit === 1 ? 'y' : 'ies'}`}.
        Choose the markets and trades you actually work. You can change these later.</p>

      <section aria-label="Subscription expectations" style={{
        background: 'linear-gradient(135deg,#101816,#0c1211)', border: '1px solid #23312d', borderRadius: 12,
        padding: '16px 18px', margin: '20px 0', lineHeight: 1.55,
      }}>
        <strong>What happens next</strong>
        <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li>We configure your dashboard and ranked opportunity queue.</li>
          <li>Your permit summary arrives by email each week; the dashboard holds the full workflow.</li>
          <li>{isTrialing ? <>Your current 14-day trial converts to <strong>${monthlyPrice[tier]}/month</strong> unless you cancel before it ends.</> : hasBillingLink ? <>Your existing subscription remains unchanged; this step only configures delivery preferences.</> : <>Your saved preferences configure your dashboard and weekly delivery.</>}</li>
        </ol>
      </section>

      {!allCounties && (
        <section aria-labelledby="counties-h" style={{ background:'var(--pm-background-raised)', border:'1px solid var(--pm-border-default)', borderRadius:12, padding:24, boxShadow:'0 14px 38px rgba(0,0,0,.18)', marginTop:22 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:16, marginBottom:14 }}>
            <div><h2 id="counties-h" style={{ margin:'0 0 4px', fontSize:20 }}>Choose your market</h2><span style={{ fontSize:13, color:'var(--pm-text-secondary)' }}>Search by county or city. We&apos;ll prioritize this market first.</span></div>
            <span style={{ fontSize:12, fontWeight:800, color:selCounties.length===limit?'#15803d':'#64748b', background:selCounties.length===limit?'rgba(52,211,153,.12)':'#0c1211', padding:'6px 9px', borderRadius:999 }}>{selCounties.length}/{limit} selected</span>
          </div>
          <input value={countyQuery} onChange={e=>setCountyQuery(e.target.value)} placeholder="Search markets…" aria-label="Search markets"
            style={{ width:'100%', boxSizing:'border-box', padding:'12px 14px', border:'1px solid var(--pm-border-strong)', borderRadius:8, fontSize:14, marginBottom:10, background:'#0c1211', color:'#f8fafc', outline:'none' }} />
          <div style={{ border:'1px solid var(--pm-border-default)', borderRadius:10, overflow:'hidden', maxHeight:290, overflowY:'auto' }}>
            {visibleCounties.map((c,i) => {
              const on = selCounties.includes(c.key);
              return (
                <button type="button" key={c.key} disabled={!on && atCountyLimit} onClick={()=>toggleCounty(c.key)}
                  style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between', textAlign:'left', padding:'12px 14px', border:0, borderTop:i?'1px solid #23312d':0, background:on?'rgba(52,211,153,.10)':'#0c1211', color:on?'#34d399':'#e2e8f0', fontWeight:on?800:650, cursor:!on&&atCountyLimit?'not-allowed':'pointer', opacity:!on&&atCountyLimit?.45:1 }}>
                  <span>{cleanMarketName(c)}</span><span style={{ width:18,height:18,borderRadius:999,border:on?'5px solid #34d399':'1.5px solid #475569',background:'#fff',boxSizing:'border-box' }} />
                </button>
              );
            })}
            {counties.length === 0 && <div style={{ padding:16, color:'#64748b' }}>Loading markets…</div>}
            {counties.length > 0 && visibleCounties.length === 0 && <div style={{ padding:16, color:'#64748b' }}>No matching markets.</div>}
          </div>
          {!countyQuery && counties.length > 12 && <button type="button" onClick={()=>setShowAllMarkets(v=>!v)}
            style={{ marginTop:10, width:'100%', padding:'10px 12px', borderRadius:8, border:'1px solid #33413d', background:'#0c1211', color:'#34d399', fontWeight:700, cursor:'pointer' }}>
            {showAllMarkets ? 'Show fewer markets' : `View all ${counties.length} markets`}
          </button>}
        </section>
      )}

      <section aria-labelledby="trades-h" style={{ background:'var(--pm-background-raised)', border:'1px solid var(--pm-border-default)', borderRadius:12, padding:24, boxShadow:'0 14px 38px rgba(0,0,0,.18)', marginTop:18 }}>
        <h2 id="trades-h">Trades</h2>
        <p style={{ marginTop: -8, color: '#94a3b8' }}>Select at least one so your dashboard and weekly delivery prioritize relevant work.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
          {SUPPORTED_TRADES.map((t) => (
            <label key={t} style={{ padding: '16px 14px', border: selTrades.includes(t) ? '2px solid #34d399' : '1px solid #33413d', borderRadius: 10, background: selTrades.includes(t) ? 'rgba(52,211,153,.10)' : '#0c1211', color: selTrades.includes(t) ? '#34d399' : '#e2e8f0', fontWeight: 700, textTransform: 'capitalize' }}>
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
        style={{ marginTop: 24, width: '100%', padding: '15px 20px', borderRadius: 11, border: 0, background: canSubmit ? 'linear-gradient(90deg,#10b981,#34d399)' : '#33413d', color: '#fff', fontSize: 16, fontWeight: 800, cursor: canSubmit ? 'pointer' : 'not-allowed', boxShadow: canSubmit ? '0 8px 20px rgba(37,99,235,.22)' : 'none' }}>
        {saving ? 'Saving…' : done ? 'Saved' : isProvisionedEntitlement ? 'Save delivery preferences' : 'Activate my permit delivery'}
      </button>
    </main>
  );
}
