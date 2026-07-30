// Pure, testable field spec + formatting for the read-only Permit Detail Drawer.
// Reads ONLY fields already present on the loaded permit object (same UPPER_SNAKE keys +
// lowercase fallbacks used elsewhere). No new data source, no fetch. Missing values → '—',
// mirroring how the permits table already renders absent fields.

export type PermitFieldKind = 'text' | 'date' | 'currency' | 'trade';

export interface PermitField {
  label: string;
  keys: string[];
  kind: PermitFieldKind;
}

// Order matches the requested drawer layout exactly.
export const PERMIT_DETAIL_FIELDS: PermitField[] = [
  { label: 'Permit Number',   keys: ['PERMITNO', 'permit_no', 'permit_number', 'permit_id'], kind: 'text' },
  { label: 'County',          keys: ['county', 'COUNTY'], kind: 'text' },
  { label: 'Status',          keys: ['STATUS', 'status'], kind: 'text' },
  { label: 'Issue Date',      keys: ['LAST_ISSUED_DATE', 'last_issued_date', 'permit_date', 'issue_date'], kind: 'date' },
  { label: 'Address',         keys: ['FULL_ADDRESS', 'full_address', 'address'], kind: 'text' },
  { label: 'Owner',           keys: ['OWNER_NAME', 'owner_name', 'owner'], kind: 'text' },
  { label: 'Contractor',      keys: ['CONTRACTOR_NAME', 'contractor_name', 'contractor'], kind: 'text' },
  { label: 'Description',     keys: ['PERMIT_DESCRIPTION', 'permit_description', 'description'], kind: 'text' },
  { label: 'Work Description', keys: ['WORK_DESCRIPTION', 'work_description'], kind: 'text' },
  { label: 'Trade',           keys: ['trade', 'TRADE'], kind: 'trade' },
  { label: 'Valuation',       keys: ['FINAL_VALUATION', 'final_valuation', 'value', 'valuation'], kind: 'currency' },
];

const EMPTY = '—';

function pick(permit: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = permit?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Display string for a drawer field. Missing → '—'. Currency mirrors the permits table
 *  ($ + thousands, only when > 0). Trade replaces underscores for readability. */
export function formatPermitField(permit: Record<string, any>, field: PermitField): string {
  const raw = pick(permit, field.keys);
  if (raw === undefined) return EMPTY;
  switch (field.kind) {
    case 'currency': {
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) && n > 0 ? `$${n.toLocaleString()}` : EMPTY;
    }
    case 'trade':
      return String(raw).replace(/_/g, ' ').trim() || EMPTY;
    case 'date':
    case 'text':
    default:
      return String(raw).trim() || EMPTY;
  }
}
