// Pure, testable field spec + formatting for the read-only Permit Detail Drawer.
// Reads ONLY fields already present on the loaded permit object (same UPPER_SNAKE keys +
// lowercase fallbacks used elsewhere). No new data source, no fetch, no fabrication.
//
// When a field is absent for this permit (e.g. Marion's EnerGov feed does not supply owner,
// contractor, or valuation), we show an honest, expectation-setting message rather than a bare
// dash — the value isn't hidden or missing on our side, the county's system simply didn't provide
// it. This is the same record already loaded for the row; we only present it more completely.

export type PermitFieldKind = 'text' | 'date' | 'currency' | 'trade';

export interface PermitField {
  label: string;
  keys: string[];
  kind: PermitFieldKind;
}

// Every attribute already carried on a permit record. Fields blank for a given county (Marion has
// no owner/contractor/valuation; Alachua has no permit type/status) render the honest NOT_PROVIDED
// message — nothing is fabricated. "Work Description" is intentionally NOT a separate row: no county
// supplies a distinct work-description field, so Description (PERMIT_DESCRIPTION) is the work text.
export const PERMIT_DETAIL_FIELDS: PermitField[] = [
  { label: 'Permit Number', keys: ['PERMITNO', 'permit_no', 'permit_number', 'permit_id'], kind: 'text' },
  { label: 'Permit Type',   keys: ['RECORD_TYPE', 'record_type', 'permit_type'], kind: 'text' },
  { label: 'Description',   keys: ['PERMIT_DESCRIPTION', 'permit_description', 'description'], kind: 'text' },
  { label: 'Status',       keys: ['STATUS', 'status'], kind: 'text' },
  { label: 'Issue Date',   keys: ['LAST_ISSUED_DATE', 'last_issued_date', 'ISSUED_DT', 'issued_dt', 'permit_date', 'issue_date'], kind: 'date' },
  { label: 'Address',      keys: ['FULL_ADDRESS', 'full_address', 'address'], kind: 'text' },
  { label: 'Owner',        keys: ['OWNER_NAME', 'owner_name', 'owner'], kind: 'text' },
  { label: 'Contractor',   keys: ['CONTRACTOR_NAME', 'contractor_name', 'contractor'], kind: 'text' },
  { label: 'Trade',        keys: ['trade', 'TRADE'], kind: 'trade' },
  { label: 'Valuation',    keys: ['FINAL_VALUATION', 'final_valuation', 'value', 'valuation'], kind: 'currency' },
  { label: 'County',       keys: ['county', 'COUNTY'], kind: 'text' },
];

// Compact placeholder (default) — used by the Contractor Profile's recent-permit list and anywhere
// a terse blank is preferred. The drawer opts into the honest sentence below.
const EMPTY_DASH = '—';
// Honest, expectation-setting placeholder for a field the county's permitting system didn't supply.
export const NOT_PROVIDED = "Not provided by this county's permitting system.";

function pick(permit: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = permit?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Display string for a drawer field. Absent/blank → `empty` (never fabricated; defaults to '—' so
 *  existing callers like the Contractor Profile are unchanged; the drawer passes NOT_PROVIDED).
 *  Currency mirrors the permits table ($ + thousands, only when > 0). Trade replaces underscores. */
export function formatPermitField(permit: Record<string, any>, field: PermitField, empty: string = EMPTY_DASH): string {
  const raw = pick(permit, field.keys);
  if (raw === undefined) return empty;
  switch (field.kind) {
    case 'currency': {
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) && n > 0 ? `$${n.toLocaleString()}` : empty;
    }
    case 'trade':
      return String(raw).replace(/_/g, ' ').trim() || empty;
    case 'date':
    case 'text':
    default:
      return String(raw).trim() || empty;
  }
}

/** True when the value is the honest "not provided" placeholder (for styling it more subtly). */
export function isNotProvided(value: string): boolean {
  return value === NOT_PROVIDED;
}
