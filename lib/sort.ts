// Pure, testable client-side sorting for the already-authorized + already-filtered permit list.
// Runs LAST in the pipeline: authorized → county/trade/date filters → keyword search → sort →
// visible rows + CSV. Never fetches, never mutates the input, never changes entitlement.
//
// Field pickers mirror lib/csv / lib/search / page.tsx (UPPER_SNAKE with lowercase fallbacks).

export type SortOption =
  | '' | 'newest' | 'oldest' | 'value_desc' | 'value_asc' | 'permit_asc' | 'address_asc';

export const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: '', label: 'Sort: Default' },        // preserves the current server-returned order
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'value_desc', label: 'Highest valuation' },
  { value: 'value_asc', label: 'Lowest valuation' },
  { value: 'permit_asc', label: 'Permit number A–Z' },
  { value: 'address_asc', label: 'Address A–Z' },
];

const DATE_KEYS = ['LAST_ISSUED_DATE', 'last_issued_date', 'permit_date', 'issue_date'];
const VALUE_KEYS = ['FINAL_VALUATION', 'final_valuation', 'value', 'valuation'];
const PERMIT_KEYS = ['PERMITNO', 'permit_no', 'permit_number', 'permit_id'];
const ADDR_KEYS = ['FULL_ADDRESS', 'full_address', 'address'];

function pick(row: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = row?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Parsed issue-date timestamp, or NaN when missing/invalid. */
function dateValue(row: Record<string, any>): number {
  const raw = pick(row, DATE_KEYS);
  if (raw === undefined) return NaN;
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? NaN : t;
}

/** Numeric valuation (strip non-numeric like the table does), or NaN when missing/invalid. */
function numValue(row: Record<string, any>): number {
  const raw = pick(row, VALUE_KEYS);
  if (raw === undefined) return NaN;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isNaN(n) ? NaN : n;
}

function strValue(row: Record<string, any>, keys: string[]): string {
  const v = pick(row, keys);
  return v === undefined ? '' : String(v);
}

// Missing values (NaN / '') always sort LAST, deterministically, regardless of direction.
function cmpNum(av: number, bv: number, dir: 1 | -1): number {
  const aBad = Number.isNaN(av), bBad = Number.isNaN(bv);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  if (av === bv) return 0;
  return av < bv ? -dir : dir;
}
function cmpStr(av: string, bv: string): number {
  const aBad = av === '', bBad = bv === '';
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
}

type Cmp = (a: Record<string, any>, b: Record<string, any>) => number;
const COMPARATORS: Record<Exclude<SortOption, ''>, Cmp> = {
  newest:      (a, b) => cmpNum(dateValue(a), dateValue(b), -1),
  oldest:      (a, b) => cmpNum(dateValue(a), dateValue(b), 1),
  value_desc:  (a, b) => cmpNum(numValue(a), numValue(b), -1),
  value_asc:   (a, b) => cmpNum(numValue(a), numValue(b), 1),
  permit_asc:  (a, b) => cmpStr(strValue(a, PERMIT_KEYS), strValue(b, PERMIT_KEYS)),
  address_asc: (a, b) => cmpStr(strValue(a, ADDR_KEYS), strValue(b, ADDR_KEYS)),
};

/**
 * Return a NEW array of the supplied rows, sorted by `option`. Default/unknown option preserves
 * the input order (returns a copy). Stable (equal values keep prior order via index tiebreak).
 * Pure — the input array is never mutated; the same returned array is used for the visible rows
 * AND the CSV export so on-screen order matches the file.
 */
export function sortPermits<T extends Record<string, any>>(rows: T[], option: SortOption): T[] {
  const arr = (rows || []).slice();
  const cmp = option ? COMPARATORS[option] : undefined;
  if (!cmp) return arr; // default / unknown → current order (copy, not mutated)
  return arr
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const c = cmp(a.row, b.row);
      return c !== 0 ? c : a.i - b.i; // stable: preserve prior order on ties
    })
    .map(x => x.row);
}

// ── Click-to-sort table headers ──────────────────────────────────────────────
// Only columns with an existing comparator are sortable. Date/Value toggle between their two
// directions (starting descending); Address is ascending-only because no `address_desc`
// comparator exists — repeated clicks stay ascending (we never invent a descending address sort).
export type SortColumn = 'date' | 'value' | 'address';

/** Next `sortOption` after clicking a sortable header, given the current option. */
export function nextSortForColumn(column: SortColumn, current: SortOption): SortOption {
  switch (column) {
    case 'date':    return current === 'newest' ? 'oldest' : 'newest';
    case 'value':   return current === 'value_desc' ? 'value_asc' : 'value_desc';
    case 'address': return 'address_asc';
    default:        return current;
  }
}

/** Header sort indicator for aria-sort + the arrow glyph. 'none' when this column isn't active. */
export function sortIndicatorForColumn(
  column: SortColumn, current: SortOption,
): 'ascending' | 'descending' | 'none' {
  switch (column) {
    case 'date':    return current === 'newest' ? 'descending' : current === 'oldest' ? 'ascending' : 'none';
    case 'value':   return current === 'value_desc' ? 'descending' : current === 'value_asc' ? 'ascending' : 'none';
    case 'address': return current === 'address_asc' ? 'ascending' : 'none';
    default:        return 'none';
  }
}
