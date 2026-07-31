// Pure, testable aggregation for the read-only Contractor Profile (v1).
//
// Aggregates ONLY the permits array it is handed — which the dashboard supplies as the
// currently-selected county's already-loaded permits. No fetch, no storage, no cross-county
// data, no entitlement logic. Field keys + display formatting are reused from lib/permitDetail
// so the profile matches the table and permit drawer exactly. Contractor matching is minimal
// (trim + case-insensitive); the original name is preserved for display.

import { PERMIT_DETAIL_FIELDS, formatPermitField, type PermitField } from './permitDetail';
import { sortPermits } from './sort';

const byLabel = (label: string): PermitField => {
  const f = PERMIT_DETAIL_FIELDS.find(x => x.label === label);
  if (!f) throw new Error(`Missing permit field: ${label}`);
  return f;
};
const F_CONTRACTOR = byLabel('Contractor');
const F_VALUATION  = byLabel('Valuation');
const F_DATE       = byLabel('Issue Date');
const F_TRADE      = byLabel('Trade');
const F_PERMITNO   = byLabel('Permit Number');
const F_ADDRESS    = byLabel('Address');
const F_STATUS     = byLabel('Status');

const EMPTY = '—';
const RECENT_LIMIT = 10;

/** First non-empty value among the field's keys (mirrors lib/permitDetail's private pick). */
function pick(permit: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = permit?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Raw contractor name as stored on the permit (untrimmed), or '' when absent. Used both for
 *  matching and to decide whether the drawer's Contractor value is interactive. */
export function getContractorName(permit: Record<string, any>): string {
  const v = pick(permit, F_CONTRACTOR.keys);
  return v === undefined ? '' : String(v);
}

/** Minimal match key: trim + lowercase. NO fuzzy matching, punctuation stripping, or suffix
 *  normalization — the displayed name is never altered by this. */
export function normalizeContractor(name: string): string {
  return (name ?? '').trim().toLowerCase();
}

/** Parse a valuation to a positive number, or null. Mirrors the table/drawer convention
 *  ($ + commas stripped; only values > 0 count). Invalid/missing → null (never throws). */
export function parseValuation(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Money display matching the drawer/table ($ + toLocaleString). Null → em dash. */
export function formatMoney(n: number | null): string {
  return n === null ? EMPTY : `$${n.toLocaleString()}`;
}

function dateTs(permit: Record<string, any>): number {
  const raw = pick(permit, F_DATE.keys);
  const t = raw === undefined ? NaN : Date.parse(String(raw));
  return Number.isNaN(t) ? -Infinity : t;
}

export interface RecentPermit {
  permitNumber: string;
  issueDate: string;
  address: string;
  trade: string;
  valuation: string;
  status: string;
}

export interface ContractorProfileData {
  displayName: string;        // original contractor name, preserved for display
  county: string;             // explicit input — the currently-selected county
  permitCount: number;
  totalValuation: number | null;   // sum of valid (>0) valuations; null when none valid
  averageValuation: number | null; // total / validValuationCount; null when none valid
  validValuationCount: number;     // denominator for the average (permits with a valid valuation)
  mostRecentDate: string | null;   // display date of the newest-dated matching permit; null if none
  trades: string[];                // unique raw trade tokens among matching permits
  recentPermits: RecentPermit[];   // newest first, capped at RECENT_LIMIT (10)
}

/**
 * Aggregate a single contractor's activity from the supplied permits (current county only).
 * Returns null for an empty/whitespace contractor name (no profile). Never mutates `permits`.
 *
 * Matching: normalizeContractor(getContractorName(p)) === normalizeContractor(displayName).
 * Average denominator: validValuationCount = number of matching permits whose valuation parses
 * to a positive number. total/average are null when validValuationCount === 0.
 */
export function buildContractorProfile(
  permits: Record<string, any>[],
  displayName: string,
  county: string,
): ContractorProfileData | null {
  const target = normalizeContractor(displayName);
  if (!target) return null; // empty contractor name → no profile

  const matched = (permits || []).filter(p => normalizeContractor(getContractorName(p)) === target);

  const valuations = matched
    .map(p => parseValuation(pick(p, F_VALUATION.keys)))
    .filter((n): n is number => n !== null);
  const validValuationCount = valuations.length;
  const totalValuation = validValuationCount ? valuations.reduce((a, b) => a + b, 0) : null;
  const averageValuation = validValuationCount ? (totalValuation as number) / validValuationCount : null;

  // Newest-dated matching permit (ignores missing/invalid dates); null if none have a valid date.
  let newest: Record<string, any> | null = null;
  let newestTs = -Infinity;
  for (const p of matched) {
    const ts = dateTs(p);
    if (ts > newestTs) { newestTs = ts; newest = p; }
  }
  const mostRecentDate = newest && newestTs !== -Infinity ? formatPermitField(newest, F_DATE) : null;

  const trades = Array.from(new Set(
    matched.map(p => String(pick(p, F_TRADE.keys) ?? '').trim()).filter(Boolean),
  ));

  const recentPermits: RecentPermit[] = sortPermits(matched, 'newest')
    .slice(0, RECENT_LIMIT)
    .map(p => ({
      permitNumber: formatPermitField(p, F_PERMITNO),
      issueDate:    formatPermitField(p, F_DATE),
      address:      formatPermitField(p, F_ADDRESS),
      trade:        formatPermitField(p, F_TRADE),
      valuation:    formatPermitField(p, F_VALUATION),
      status:       formatPermitField(p, F_STATUS),
    }));

  return {
    displayName,
    county,
    permitCount: matched.length,
    totalValuation,
    averageValuation,
    validValuationCount,
    mostRecentDate,
    trades,
    recentPermits,
  };
}

export { RECENT_LIMIT };
