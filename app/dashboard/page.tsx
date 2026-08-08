'use client';

import { useEffect, useState, useRef } from 'react';
import { useUser, useAuth } from '@clerk/nextjs';
import { apiFetch, getSavedLeads, saveLead, getCoverage, type CountyCoverage } from '../../lib/api';
import { saveLeadPermitId, canSaveLead, savedIdsAfter } from '../../lib/saveLeadState';
import {
  buildPermitsPath, commitDelayMs, createLatest,
  showPermitEmptyState, showPermitFooter, csvDisabled,
} from '../../lib/liveSearch';
import {
  effectiveRange, isValidCustomRange, formatHuman, type DatePreset, type DateRange,
} from '../../lib/dateRange';
import { buildPermitCsv, createExportFilename } from '../../lib/csv';
import { tradeColor, tradeOptions } from '../../lib/trades';
import { effectivePermitDate, dateLabel as coverageDateLabel } from '../../lib/dateBasis';
import { sortPermits, SORT_OPTIONS, nextSortForColumn, sortIndicatorForColumn, type SortOption, type SortColumn } from '../../lib/sort';
import { INITIAL_VISIBLE, shownCount, shouldShowLoadMore, nextVisibleCount } from '../../lib/tableView';
import { isCountyLocked, defaultEntitledCounty, upgradeMessageForCounty } from '../../lib/entitlement';
import CallList from './_components/CallList';
import DigestCard from './_components/DigestCard';
import UpgradeModal from './_components/UpgradeModal';
import PermitDrawer from './_components/PermitDrawer';
import DashboardLoadingSkeleton from './_components/DashboardLoadingSkeleton';
import PermitTableSkeleton from './_components/PermitTableSkeleton';
import ContractorProfile from './_components/ContractorProfile';
import SavedSearches from './_components/SavedSearches';
import { buildContractorProfile } from '../../lib/contractorProfile';
import { track } from '../../lib/analytics';
import {
  shouldEmitDashboardView, dashboardViewedEvent, permitDrawerOpenEvent,
  contractorProfileViewEvent, csvExportEvent, savedLeadEvent,
} from '../../lib/activationEvents';
import { startCheckout } from '../../lib/start-checkout';
import SavedLeads from './_components/SavedLeads';
import { promoteSignupCounty, dismissFirstLogin } from '../actions';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import {
  MapPin, TrendingUp, Zap, Building2, Target,
  ChevronRight, ChevronUp, ChevronDown, Star, AlertCircle, Lock, X
} from 'lucide-react';

// API base + auth lives in lib/api.ts (apiFetch attaches the Clerk JWT when available).

// Tier limits. `preview` is the unpaid state (no paid tier metadata) — NOT a free
// Starter. Signing up never assigns a paid tier; only the Stripe webhook does. Data
// access is server-authoritative (preview_locked); these limits are display/fetch caps.
const TIER_LIMITS: Record<string, { counties: number; permits: number; label: string }> = {
  preview: { counties: 1, permits: 50,  label: 'Preview' },
  starter: { counties: 1, permits: 50,  label: 'Starter' },
  pro:     { counties: 5, permits: 500, label: 'Pro' },
  team:    { counties: 99, permits: 9999, label: 'Team' },
};

// Trade order/colors/demand live in lib/trades (ONE source of truth). Generator + foundation
// are first-class there, and unknown/new API trades render with a neutral color + appear in
// filters automatically — so a future trade needs zero dashboard changes.

const SCORE_COLOR = (s: number) =>
  s >= 80 ? '#22c55e' : s >= 60 ? '#f97316' : s >= 40 ? '#eab308' : '#6b7280';

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
        <button onClick={() => startCheckout('starter')} style={{
          background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700,
          padding: '10px 22px', borderRadius: 8, border: 'none', cursor: 'pointer' }}>
          Start Starter trial →
        </button>
        <button onClick={() => startCheckout('pro')} style={{
          background: 'transparent', color: '#93c5fd', fontSize: 13, fontWeight: 600,
          padding: '10px 18px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid #2563eb60' }}>
          Pro
        </button>
        <button onClick={() => startCheckout('team')} style={{
          background: 'transparent', color: '#93c5fd', fontSize: 13, fontWeight: 600,
          padding: '10px 18px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid #2563eb60' }}>
          Team
        </button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useUser();
  const { getToken } = useAuth();
  // No paid tier metadata = Preview (the only free/unpaid state). Never default to Starter.
  const tier = (user?.publicMetadata?.tier as string) || 'preview';
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.preview;
  // Authoritative entitlement for the selector: which specific counties this user may open.
  const allowedCounties = (user?.publicMetadata?.allowed_counties as string[]) || [];

  const [counties, setCounties]     = useState<any[]>([]);
  const [county, setCounty]         = useState('');  // '' until resolved (localStorage / Clerk metadata) or user picks
  const [summary, setSummary]       = useState<any>(null);
  const [permits, setPermits]       = useState<any[]>([]);
  const [scored, setScored]         = useState<any[]>([]);
  const [digest, setDigest]         = useState<any>(null);
  const [loading, setLoading]       = useState(true);
  const [activeTab, setActiveTab]   = useState<'opportunities' | 'permits' | 'trends' | 'insights' | 'saved'>('opportunities');
  const [tradeFilter, setTradeFilter] = useState('');
  const [search, setSearch]         = useState('');       // raw search-box value (drives the debounce)
  const [committedQuery, setCommittedQuery] = useState(''); // debounced/committed query sent to /permits
  const [permitsLoading, setPermitsLoading] = useState(true); // permits-list-only loading (search + county)
  const latestPermits = useRef(createLatest());           // newest-wins guard for the permits fetch
  const [upgrade, setUpgrade] = useState<
    { trigger: 'locked_county' | 'get_full_access_button'; county: any | null } | null
  >(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [sortOption, setSortOption]   = useState<SortOption>(''); // '' = current server order (default)
  const [selectedPermit, setSelectedPermit] = useState<any | null>(null); // read-only detail drawer
  const rowRef = useRef<HTMLTableRowElement | null>(null);               // return focus here on close
  const upgradeTriggerRef = useRef<HTMLElement | null>(null);            // return focus to the UpgradeModal opener on close
  const dashboardViewedRef = useRef(false);                              // dashboard_viewed: emit once per mount (after county resolves)
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);     // "Load more" — +50 per click
  const [selectedContractor, setSelectedContractor] = useState<string | null>(null); // Contractor Profile (shown instead of the drawer)
  const [focusContractorBtn, setFocusContractorBtn] = useState(false);   // return focus to the contractor button when the profile closes
  // Existing Saved Leads "save" action, surfaced in the drawer. Reuses the same backend/identity
  // as the Opportunities star (lib/api.saveLead); page-level state so it survives the drawer
  // unmount/remount around the Contractor Profile. CallList keeps its own independent star state.
  const [savedLeadIds, setSavedLeadIds] = useState<Set<string>>(new Set());
  const [savingLeadId, setSavingLeadId] = useState<string | null>(null);
  const [saveLeadError, setSaveLeadError] = useState(false);

  // PR2: historical date-range controls (server-side date filtering via /permits?date_from/date_to).
  const [datePreset, setDatePreset] = useState<DatePreset>('all');   // default 'all' = current no-date behavior
  const [dateFrom, setDateFrom] = useState('');                      // custom-range inputs (YYYY-MM-DD)
  const [dateTo, setDateTo] = useState('');
  const [coverage, setCoverage] = useState<CountyCoverage | null>(null);  // county history bounds
  const [coverageError, setCoverageError] = useState(false);              // non-fatal "History range unavailable"
  const [committedRange, setCommittedRange] = useState<DateRange>({ from: null, to: null }); // what's actually sent
  const latestCoverage = useRef(createLatest());                     // newest-wins guard for coverage on county switch
  const covBounds = coverage ? { from: coverage.history_start, to: coverage.history_end } : null;

  // Reset the visible window whenever the result set meaningfully changes (county / trade /
  // committed query / sort). Keyed on committedQuery (not the raw keystroke `search`), so the window
  // resets once per committed search, not on every character. Applying a saved search flows through
  // these setters, so it resets too. Opening/closing the drawer never touches these deps.
  useEffect(() => { setVisibleCount(INITIAL_VISIBLE); }, [county, tradeFilter, committedQuery, sortOption, committedRange.from, committedRange.to]);

  // Live search: commit the trimmed query ~275 ms after typing stops. Blank/cleared commits
  // immediately (commitDelayMs → 0), so clearing the box instantly reloads the unfiltered list.
  // Pressing Enter commits immediately via the input's onKeyDown (below), bypassing this timer.
  useEffect(() => {
    const delay = commitDelayMs(search);
    if (delay === 0) { setCommittedQuery(search.trim()); return; }
    const t = setTimeout(() => setCommittedQuery(search.trim()), delay);
    return () => clearTimeout(t);
  }, [search]);

  // County change → close the drawer and Contractor Profile so no stale (other-county) data can
  // remain visible. The profile aggregates only the current county's loaded permits.
  useEffect(() => { setSelectedPermit(null); setSelectedContractor(null); setFocusContractorBtn(false); }, [county]);

  // Locked county click → record the lock view and open the upgrade modal
  // (instead of silently doing nothing). The modal fires upgrade_modal_open itself.
  const openUpgrade = (c: any, trigger?: HTMLElement | null) => {
    upgradeTriggerRef.current = trigger ?? null; // remember the opener to restore focus on close
    track(getToken, 'locked_county_view', { county: c.key, source: 'county_sidebar' });
    setUpgrade({ trigger: 'locked_county', county: c });
  };

  // "Get Full Access" button → open the modal generically (no specific county).
  const openFullAccess = (trigger?: HTMLElement | null) => {
    upgradeTriggerRef.current = trigger ?? null;
    setUpgrade({ trigger: 'get_full_access_button', county: null });
  };

  // Persist a county choice so the dashboard reopens to it instantly (PART D).
  const selectCounty = (key: string) => {
    setCounty(key);
    try { localStorage.setItem('permitmap_county', key); } catch { /* ignore */ }
  };

  // Dismiss the first-login banner and persist it server-side (PART C).
  const dismissWelcome = () => {
    setShowWelcome(false);
    dismissFirstLogin().catch(() => {});
  };

  // Load counties
  useEffect(() => {
    apiFetch('/counties', getToken)
      .then(r => r.json())
      .then(d => setCounties(d.counties || []))
      .catch(() => {});
  }, [getToken]);

  // Resolve the initial county once (PART A/B): a prior choice (localStorage) wins,
  // else the county from Clerk publicMetadata; for a brand-new signup the county was
  // stored as unsafeMetadata at /sign-up?county= and is promoted to publicMetadata
  // server-side here. Slugs ("palm-beach") map to API keys ("palm_beach").
  useEffect(() => {
    if (county) return; // already chosen this session
    let cancelled = false;
    (async () => {
      let resolved = '';
      try { resolved = localStorage.getItem('permitmap_county') || ''; } catch { /* ignore */ }
      if (!resolved && user) {
        const meta = (user.publicMetadata?.county as string) || '';   // returning user
        resolved = meta || (await promoteSignupCounty().catch(() => null)) || ''; // new signup
      }
      // Fall back to the first county the user is actually entitled to — so the dashboard
      // never defaults to (or strands the user behind) a locked county.
      if (!resolved) resolved = defaultEntitledCounty(counties, tier, allowedCounties);
      if (resolved && !cancelled) setCounty(resolved.trim().toLowerCase().replace(/-/g, '_'));
    })();
    return () => { cancelled = true; };
  }, [user, county, counties, tier]);

  // dashboard_viewed — fire once per mount, only after the county resolves so the payload carries
  // it. Ref-guarded, so it never re-emits on tab change or rerender. Fire-and-forget analytics only.
  useEffect(() => {
    if (shouldEmitDashboardView(dashboardViewedRef.current, county)) {
      dashboardViewedRef.current = true;
      const e = dashboardViewedEvent(county, activeTab, tier);
      track(getToken, e.event, e.props);
    }
  }, [county, activeTab, tier, getToken]);

  // First-login onboarding (PART C): shown until dismissed (publicMetadata.firstLogin === false).
  useEffect(() => {
    if (user) setShowWelcome(user.publicMetadata?.firstLogin !== false);
  }, [user]);

  // Load summary + scored + digest when county changes. Permits are fetched SEPARATELY (below) so a
  // keyword search re-fetches only the permits list — not the Opportunity queue, summary, or digest.
  useEffect(() => {
    if (!county) { setLoading(false); return; }  // nothing selected yet -> show the county picker
    setLoading(true);
    Promise.all([
      apiFetch(`/summary?county=${county}`, getToken).then(r => r.json()),
      // Phase A: ranked opportunities. 403 for preview/no-tier -> empty (the tab shows PreviewLock).
      apiFetch(`/permits/scored?county=${county}&top_n=50`, getToken)
        .then(r => (r.ok ? r.json() : { permits: [] }))
        .catch(() => ({ permits: [] })),
      // Phase B: weekly digest briefing. 403 for preview/no-tier -> null (card hidden).
      apiFetch(`/digest?county=${county}`, getToken)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([s, sc, dg]) => {
      setSummary(s);
      setScored(sc.permits || []);
      setDigest(dg);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [county, limits.permits, getToken]);

  // Permits list — its own fetch, keyed on the committed query (server-side keyword search runs over
  // the full authorized dataset BEFORE the tier cap). AbortController cancels the in-flight request
  // on any change (query/county/limit/unmount); the newest-wins guard ignores a stale response that
  // resolves late. Blank query omits the param → identical to the pre-search request.
  useEffect(() => {
    if (!county) { setPermits([]); setPermitsLoading(false); return; }
    const requestId = latestPermits.current.begin();
    const controller = new AbortController();
    setPermitsLoading(true);
    apiFetch(buildPermitsPath(county, limits.permits, committedQuery, committedRange.from, committedRange.to), getToken, { signal: controller.signal })
      .then(r => r.json())
      .then(p => {
        if (!latestPermits.current.isCurrent(requestId)) return; // a newer search superseded this one
        setPermits(p.permits || []);
        setPermitsLoading(false);
      })
      .catch(err => {
        if (err?.name === 'AbortError' || !latestPermits.current.isCurrent(requestId)) return; // ignore aborts/stale
        setPermits([]);          // non-abort failure: fall back to empty (existing permits error behavior)
        setPermitsLoading(false);
      });
    return () => controller.abort();
  }, [county, limits.permits, getToken, committedQuery, committedRange.from, committedRange.to]);

  // Coverage fetch — separate, non-blocking. Refetches on county change (newest-wins + abort so a
  // fast switch can't show stale bounds). Failure (404 not-covered / 503 / network) → coverageError,
  // which only degrades the History control; permit search stays fully usable.
  useEffect(() => {
    if (!county) { setCoverage(null); setCoverageError(false); return; }
    const id = latestCoverage.current.begin();
    const controller = new AbortController();
    setCoverage(null); setCoverageError(false);
    getCoverage(county, getToken, controller.signal)
      .then(c => { if (latestCoverage.current.isCurrent(id)) setCoverage(c); })
      .catch(err => {
        if (err?.name === 'AbortError' || !latestCoverage.current.isCurrent(id)) return;
        setCoverageError(true);
      });
    return () => controller.abort();
  }, [county, getToken]);

  // Reset the date control to "All available" when the county changes (bounds differ per county).
  useEffect(() => { setDatePreset('all'); setDateFrom(''); setDateTo(''); }, [county]);

  // Commit the effective range to send. Presets/all commit immediately; an INVALID custom range does
  // NOT commit (issues no request), so typing a half-entered custom range never fires a fetch.
  useEffect(() => {
    if (datePreset === 'custom' && !isValidCustomRange(dateFrom || null, dateTo || null)) return;
    setCommittedRange(effectiveRange(datePreset, dateFrom || null, dateTo || null, covBounds));
  }, [datePreset, dateFrom, dateTo, coverage]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Load the caller's saved-lead permit_ids once (auth-gated; preview/403/network → empty, like
  // CallList). Drives the drawer's saved/Save-lead state. Independent of CallList's own star state.
  useEffect(() => {
    let cancelled = false;
    getSavedLeads(getToken)
      .then(d => { if (!cancelled) setSavedLeadIds(new Set((d.leads || []).map(l => l.permit_id))); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [getToken]);

  // Drawer "Save lead" — reuses the exact existing saveLead flow, payload, identity, and dedup.
  // Paid-only (isPreview guard, defense-in-depth atop the preview-locked Permits table). Never
  // touches county/search/sort/filters/visibleCount/selectedPermit. Removal stays in the Saved tab.
  const handleSaveLead = async (permit: any) => {
    const pid = saveLeadPermitId(permit);
    if (isPreview || !canSaveLead(pid, savedLeadIds, savingLeadId)) return;
    setSaveLeadError(false);
    setSavingLeadId(pid);
    try {
      const res = await saveLead(getToken, permit);
      setSavedLeadIds(prev => savedIdsAfter(prev, pid, res.already_saved ? 'already_saved' : 'success'));
      // saved_lead — only after the save resolves (success or already_saved). Not in catch, not on
      // click. Fire-and-forget; can never affect save state or the drawer.
      const ev = savedLeadEvent(res, permit);
      track(getToken, ev.event, ev.props);
    } catch {
      setSaveLeadError(true); // leave unsaved → retry allowed
    } finally {
      setSavingLeadId(null);
    }
  };

  // Single permit-open handler for BOTH the row click and keyboard (Enter/Space) paths, so
  // permit_drawer_open tracking can never drift between them. Emits once per actual open.
  const openPermitDrawer = (p: any, rowEl: HTMLTableRowElement | null) => {
    if (rowEl) rowRef.current = rowEl;
    setFocusContractorBtn(false);
    setSelectedPermit(p);
    const ev = permitDrawerOpenEvent(p);
    track(getToken, ev.event, ev.props);
  };

  // Contractor Profile open — shared handler so tracking sits with the state change. permit_count is
  // derived by REUSING buildContractorProfile (the same aggregation the profile renders); null when
  // it can't be computed, in which case the field is omitted from the payload.
  const openContractor = (name: string) => {
    setSelectedContractor(name);
    const permitCount = buildContractorProfile(permits, name, county)?.permitCount ?? null;
    const ev = contractorProfileViewEvent(name, county, permitCount);
    track(getToken, ev.event, ev.props);
  };

  // Keyword search is now SERVER-side (permits already match `committedQuery`). The client pipeline
  // only applies the trade filter, then sorts — over the server-returned, authorized set. Trade
  // filtering stays client-side, exactly as before. Blank query → server returned the full list.
  const tradeFilteredPermits = tradeFilter ? permits.filter(p => p.trade === tradeFilter) : permits;

  // Sorting runs LAST in the pipeline, over the already-filtered/authorized set. The same
  // array feeds the visible rows AND the CSV export so on-screen order matches the file.
  // Default ('') preserves the current server-returned order. Pure; never mutates/​fetches.
  const displayedPermits = sortPermits(tradeFilteredPermits, sortOption);

  // The permit date dimension is API-declared per county (coverage.date_basis/date_label):
  // an "issued" county shows "Permit issued" from LAST_ISSUED_DATE; an "opened" county (Citrus)
  // shows "Record opened" from OPENED_DATE. The dashboard renders whatever the API declares —
  // never hardcoding the field or label, so future counties are zero-code here.
  const permitDateLabel = coverage ? coverageDateLabel(coverage) : 'Date';
  const permitDateBasis = coverage?.date_basis;

  // Export exactly the currently-visible (filtered + sorted + entitlement-authorized) rows. CSV
  // serialization is pure (lib/csv); only the browser download trigger lives here. Never
  // fetches or introduces additional records.
  const exportCsv = () => {
    if (displayedPermits.length === 0) return;
    const csv = buildPermitCsv(
      displayedPermits,
      coverage ? { dateBasis: coverage.date_basis, dateLabel: coverage.date_label } : undefined,
    );
    const filename = createExportFilename(
      { county, trade: tradeFilter, keyword: search },
      new Date().toISOString().slice(0, 10),
    );
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    // csv_export — after a real export (past the zero-row early return, download already triggered).
    // csvExportEvent returns null for an empty set; fire-and-forget so it never delays the download.
    const ev = csvExportEvent(displayedPermits.length, county, tradeFilter, search, sortOption);
    if (ev) track(getToken, ev.event, ev.props);
  };

  const tradeChartData = summary?.trade_breakdown
    ? Object.entries(summary.trade_breakdown).map(([trade, count]) => ({
        trade: trade.replace('_', ' '),
        count: count as number,
        fill: tradeColor(trade),
      }))
    : [];

  // Entitlement-based lock (NOT list position × tier count): a county is locked iff the user
  // is not entitled to it. Fixes entitled counties (e.g. Marion) rendering locked and
  // non-entitled counties rendering available.
  const isLocked = (c: { key: string }) => isCountyLocked(c.key, tier, allowedCounties);

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
            <button onClick={e => openFullAccess(e.currentTarget)} style={{
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
          {counties.map((c) => {
            const locked = isLocked(c);
            const active = c.key === county;
            return (
              <button key={c.key} onClick={e => (locked ? openUpgrade(c, e.currentTarget) : selectCounty(c.key))}
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

          {!county ? (
            /* PART B: no county resolved (no prior choice / no signup metadata) →
               prompt the user with the county list front-and-center. */
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '70vh', flexDirection: 'column', gap: 20, textAlign: 'center' }}>
              <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, color: '#f1f5f9', margin: '0 0 6px' }}>
                  Select your county to get started
                </h1>
                <p style={{ color: '#64748b', fontSize: 14, margin: 0 }}>
                  Pick a county to load this week's permits — we'll remember it next time.
                </p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', maxWidth: 600 }}>
                {counties.map((c) => {
                  const locked = isLocked(c);
                  return (
                    <button key={c.key} onClick={e => (locked ? openUpgrade(c, e.currentTarget) : selectCounty(c.key))}
                      style={{
                        padding: '10px 16px', borderRadius: 10, cursor: 'pointer',
                        background: locked ? 'transparent' : '#1e3a5f',
                        border: `1px solid ${locked ? '#1e293b' : '#2563eb'}`,
                        color: locked ? '#475569' : '#93c5fd', fontSize: 13, fontWeight: 600,
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                      }}>
                      {c.label}
                      {locked && <Lock size={12} color="#475569" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : loading ? (
            <DashboardLoadingSkeleton />
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

              {/* PART C: one-time first-login onboarding, above the permit content */}
              {showWelcome && !isPreview && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                  background: 'linear-gradient(135deg, #1e3a5f 0%, #0d1529 100%)',
                  border: '1px solid #2563eb40', borderRadius: 12,
                  padding: '14px 18px', marginBottom: 24, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: 14, color: '#e2e8f0' }}>
                    👋 Welcome to PermitMap. You&apos;re viewing <strong>{summary.label}</strong> permits.
                    Star any permit to save it as a lead. →
                  </span>
                  <button onClick={dismissWelcome} style={{
                    background: 'transparent', border: '1px solid #2563eb60', color: '#93c5fd',
                    borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                  }}>
                    Dismiss
                  </button>
                </div>
              )}

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
                {(['opportunities', 'permits', 'trends', 'insights', 'saved'] as const).map(tab => (
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
                    getToken={getToken}
                    dateBasis={permitDateBasis}
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
                    {tradeOptions(permits.map(p => p.trade as string)).map(t => (
                      <button key={t} onClick={() => setTradeFilter(t)} style={{
                        padding: '5px 12px', borderRadius: 20,
                        border: `1px solid ${tradeFilter === t ? (t ? tradeColor(t) : '#3b82f6') : '#1e293b'}`,
                        background: tradeFilter === t ? `${t ? tradeColor(t) : '#2563eb'}20` : 'transparent',
                        color: tradeFilter === t ? (t ? tradeColor(t) : '#3b82f6') : '#64748b',
                        fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        textTransform: 'capitalize',
                      }}>
                        {t || 'All Trades'}
                      </button>
                    ))}
                  </div>

                  {/* Keyword search — server-side (GET /permits?query=…). Live: commits ~275 ms after
                      typing stops; Enter commits immediately; clearing reloads the full list. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                    <div className="pm-permits-search" style={{ position: 'relative' }}>
                      <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') setCommittedQuery(search.trim()); }}
                        placeholder="Search permits, descriptions, contractors, addresses…"
                        aria-label="Search permits"
                        style={{
                          width: '100%', padding: '9px 34px 9px 12px', borderRadius: 8,
                          background: '#0d1529', border: '1px solid #1e293b', color: '#e2e8f0',
                          fontSize: 13, outline: 'none',
                        }}
                      />
                      {search && (
                        <button onClick={() => setSearch('')} aria-label="Clear search" style={{
                          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                          background: 'transparent', border: 'none', cursor: 'pointer',
                          color: '#475569', padding: 2, display: 'inline-flex' }}>
                          <X size={16} />
                        </button>
                      )}
                    </div>
                    <select
                      value={sortOption}
                      onChange={e => setSortOption(e.target.value as SortOption)}
                      aria-label="Sort permits"
                      style={{
                        padding: '9px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                        background: '#0d1529', border: '1px solid #1e293b', color: '#93c5fd',
                        cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>
                      {SORT_OPTIONS.map(o => (
                        <option key={o.value} value={o.value} style={{ background: '#0d1529' }}>{o.label}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>
                      {permitsLoading
                        ? 'Searching…'
                        : `${displayedPermits.length} ${displayedPermits.length === 1 ? 'match' : 'matches'}`}
                    </span>
                    <button
                      onClick={exportCsv}
                      disabled={csvDisabled(permitsLoading, displayedPermits.length)}
                      aria-label="Export CSV"
                      className="pm-btn-secondary">
                      {displayedPermits.length === 0
                        ? 'No results to export'
                        : `Export CSV (${displayedPermits.length})`}
                    </button>
                  </div>

                  {/* History date range — server-side (GET /permits?date_from/date_to). Presets are
                      anchored to the county's available_date_to (NOT today) so ingestion lag can't
                      yield an empty window. "All available" omits the params (current behavior). */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
                    <label htmlFor="pm-history-preset" style={{ fontSize: 12, fontWeight: 700, color: '#93c5fd' }}>History</label>
                    <select
                      id="pm-history-preset"
                      value={datePreset}
                      onChange={e => setDatePreset(e.target.value as DatePreset)}
                      disabled={coverageError}
                      aria-label="Permit history date range"
                      style={{ padding: '9px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                        background: '#0d1529', border: '1px solid #1e293b', color: '#e2e8f0', cursor: 'pointer' }}>
                      <option value="all" style={{ background: '#0d1529' }}>All available</option>
                      <option value="7d" style={{ background: '#0d1529' }}>Last 7 days</option>
                      <option value="30d" style={{ background: '#0d1529' }}>Last 30 days</option>
                      <option value="90d" style={{ background: '#0d1529' }}>Last 90 days</option>
                      <option value="custom" style={{ background: '#0d1529' }}>Custom range</option>
                    </select>
                    {datePreset === 'custom' && (() => {
                      const invalid = !!(dateFrom || dateTo) && !isValidCustomRange(dateFrom || null, dateTo || null);
                      const inputStyle = { padding: '8px 10px', borderRadius: 8, fontSize: 12,
                        background: '#0d1529', border: '1px solid #1e293b', color: '#e2e8f0' } as const;
                      return (
                        <>
                          <label htmlFor="pm-date-from" style={{ fontSize: 12, color: '#64748b' }}>From</label>
                          <input id="pm-date-from" type="date" value={dateFrom}
                            onChange={e => setDateFrom(e.target.value)}
                            min={covBounds?.from || undefined} max={covBounds?.to || undefined}
                            aria-label="History from date" aria-invalid={invalid}
                            aria-describedby={invalid ? 'pm-date-error' : undefined} style={inputStyle} />
                          <label htmlFor="pm-date-to" style={{ fontSize: 12, color: '#64748b' }}>To</label>
                          <input id="pm-date-to" type="date" value={dateTo}
                            onChange={e => setDateTo(e.target.value)}
                            min={covBounds?.from || undefined} max={covBounds?.to || undefined}
                            aria-label="History to date" aria-invalid={invalid}
                            aria-describedby={invalid ? 'pm-date-error' : undefined} style={inputStyle} />
                          <button type="button" className="pm-btn-secondary"
                            onClick={() => { setDatePreset('all'); setDateFrom(''); setDateTo(''); }}>Reset</button>
                          {invalid && (
                            <span id="pm-date-error" role="alert" style={{ fontSize: 12, color: '#f87171' }}>
                              Enter a valid From date on or before the To date.
                            </span>
                          )}
                        </>
                      );
                    })()}
                    {coverageError ? (
                      <span role="status" style={{ fontSize: 12, color: '#64748b' }}>History range unavailable</span>
                    ) : covBounds?.from && covBounds?.to ? (
                      <span style={{ fontSize: 12, color: '#64748b' }}>
                        Available history: {formatHuman(covBounds.from)} – {formatHuman(covBounds.to)}
                      </span>
                    ) : null}
                  </div>

                  {/* Saved searches (device-local; applies county/trade/keyword/sort) */}
                  <SavedSearches
                    current={{ county, tradeFilter, search, sortOption }}
                    counties={counties}
                    tier={tier}
                    allowedCounties={allowedCounties}
                    onApply={next => {
                      setCounty(next.county);          // setCounty (not selectCounty): never writes permitmap_county
                      setTradeFilter(next.tradeFilter);
                      setSearch(next.search);
                      setSortOption(next.sortOption);
                    }}
                  />

                  {/* Permits table — while a search/county fetch is in flight, show the shared
                      table-shaped skeleton (search controls above stay visible/typable). Never shows
                      stale rows, the empty state, the footer, or a count from the prior result set. */}
                  {permitsLoading ? (
                    <PermitTableSkeleton announce />
                  ) : (
                  <div style={{ background: '#111827', border: '1px solid #1e293b',
                    borderRadius: 12, overflow: 'hidden' }}>
                    <div className="pm-table-scroll">
                    <table className="pm-permits-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #1e293b' }}>
                          {([
                            { label: 'Score' },
                            { label: 'Address', column: 'address' as SortColumn },
                            { label: 'Type' },
                            { label: 'Trade' },
                            { label: 'Value', column: 'value' as SortColumn },
                            { label: permitDateLabel, column: 'date' as SortColumn },
                          ]).map(h => {
                            const thStyle = {
                              padding: '12px 16px', textAlign: 'left' as const,
                              fontSize: 11, fontWeight: 700,
                              textTransform: 'uppercase' as const, letterSpacing: '0.06em',
                            };
                            if (!h.column) {
                              return <th key={h.label} style={{ ...thStyle, color: '#475569' }}>{h.label}</th>;
                            }
                            const indicator = sortIndicatorForColumn(h.column, sortOption); // 'ascending' | 'descending' | 'none'
                            const active = indicator !== 'none';
                            return (
                              <th key={h.label} style={{ ...thStyle, color: active ? '#93c5fd' : '#475569' }} aria-sort={indicator}>
                                <button
                                  type="button"
                                  onClick={() => setSortOption(nextSortForColumn(h.column, sortOption))}
                                  aria-label={`Sort by ${h.label}`}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                                    color: 'inherit', fontSize: 'inherit', fontWeight: 'inherit',
                                    textTransform: 'inherit', letterSpacing: 'inherit',
                                  }}>
                                  {h.label}
                                  {indicator === 'descending' && <ChevronDown size={12} aria-hidden="true" />}
                                  {indicator === 'ascending' && <ChevronUp size={12} aria-hidden="true" />}
                                </button>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {displayedPermits.slice(0, visibleCount).map((p, i) => (
                          <tr key={i}
                            tabIndex={0}
                            role="button"
                            aria-label="View permit details"
                            onClick={e => openPermitDrawer(p, e.currentTarget)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault(); openPermitDrawer(p, e.currentTarget);
                              }
                            }}
                            style={{
                            borderBottom: '1px solid #0f172a',
                            background: i % 2 === 0 ? '#111827' : '#0d1529',
                            cursor: 'pointer',
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
                                background: `${tradeColor(p.trade)}20`,
                                color: tradeColor(p.trade),
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
                              {effectivePermitDate(p, permitDateBasis) || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                    {showPermitFooter(permitsLoading, displayedPermits.length) && (
                      <div style={{ padding: '12px 20px', borderTop: '1px solid #1e293b',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontSize: 12, color: '#64748b' }}>
                          Showing {shownCount(visibleCount, displayedPermits.length)} of {displayedPermits.length}
                        </span>
                        {shouldShowLoadMore(visibleCount, displayedPermits.length) && (
                          <button
                            type="button"
                            onClick={() => setVisibleCount(c => nextVisibleCount(c, displayedPermits.length))}
                            className="pm-btn-secondary">
                            Load more
                          </button>
                        )}
                      </div>
                    )}
                    {showPermitEmptyState(permitsLoading, displayedPermits.length) && (
                      <div style={{ padding: 40, textAlign: 'center', color: '#475569' }}>
                        {(committedRange.from || committedRange.to)
                          ? ((search || tradeFilter)
                              ? 'No permits match your filters in this date range.'
                              : 'No permits were found in this date range.')
                          : (search
                              ? 'No permits match your search and current filters.'
                              : 'No permits found for this filter.')}
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
                  )}
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

              {/* SAVED TAB (Phase C) — paid/trial only, same gate as the other tabs */}
              {activeTab === 'saved' && isPreview && (
                <PreviewLock compact />
              )}
              {activeTab === 'saved' && !isPreview && (
                <SavedLeads getToken={getToken} onBrowse={() => setActiveTab('opportunities')} />
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
          entitlementNote={upgrade.trigger === 'locked_county'
            ? upgradeMessageForCounty(
                upgrade.county?.label,
                counties.filter(c => !isCountyLocked(c.key, tier, allowedCounties)).map(c => c.label))
            : undefined}
          tier={tier}
          limits={limits}
          userId={user?.id}
          getToken={getToken}
          onClose={() => { setUpgrade(null); upgradeTriggerRef.current?.focus(); }}
        />
      )}

      {/* Permit drawer — shown when no Contractor Profile is open (single overlay at a time). */}
      {selectedPermit && !selectedContractor && (
        <PermitDrawer
          permit={selectedPermit}
          dateLabel={coverage?.date_label}
          dateBasis={coverage?.date_basis}
          focusContractorOnMount={focusContractorBtn}
          onOpenContractor={openContractor}
          canSave={!isPreview}
          saved={savedLeadIds.has(saveLeadPermitId(selectedPermit))}
          saving={savingLeadId === saveLeadPermitId(selectedPermit)}
          saveError={saveLeadError}
          onSaveLead={() => handleSaveLead(selectedPermit)}
          onClose={() => { setSelectedPermit(null); setFocusContractorBtn(false); rowRef.current?.focus(); }}
        />
      )}

      {/* Contractor Profile — replaces the drawer while open; on close, restore the drawer and
          return focus to the contractor button. Aggregates only the current county's permits. */}
      {selectedPermit && selectedContractor && (
        <ContractorProfile
          contractor={selectedContractor}
          county={county}
          permits={permits}
          onClose={() => { setSelectedContractor(null); setFocusContractorBtn(true); }}
        />
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
        * { box-sizing: border-box; }
        /* @keyframes spin now lives in app/globals.css (app-global; no longer tied to this page) */
        /* Visible keyboard focus (WCAG 2.4.7). :focus-visible = keyboard only, so mouse clicks
           stay ring-free. !important overrides the inline outline:none on the search / saved-search
           inputs. Uses the existing blue accent; outline never affects layout. */
        button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid #93c5fd !important;
          outline-offset: 2px;
        }
        /* Clickable table rows render inside an overflow:hidden container — inset the ring so it
           isn't clipped. */
        [role="button"]:focus-visible {
          outline: 2px solid #93c5fd !important;
          outline-offset: -2px;
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0f1e; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
      `}</style>
    </div>
  );
}
