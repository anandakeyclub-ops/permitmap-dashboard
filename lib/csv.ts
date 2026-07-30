// Pure CSV serialization for permit export. No DOM, no fetch, no server route — the browser
// download trigger lives in the component (keeps this module unit-testable). The caller passes
// the SAME already-filtered/authorized rows that are visible on screen; export never fetches.

// Export columns, in order. `keys` are candidate field names on the raw API permit object
// (UPPER_SNAKE, with lowercase fallbacks). Only these public fields are exported — no hidden/
// internal fields (score, trade colors, ids, etc.).
const COLUMNS: { header: string; keys: string[]; date?: boolean }[] = [
  { header: 'Permit Number', keys: ['PERMITNO', 'permit_no', 'permit_number', 'permit_id'] },
  { header: 'County', keys: ['county', 'COUNTY'] },
  { header: 'Address', keys: ['FULL_ADDRESS', 'full_address', 'address'] },
  { header: 'Owner', keys: ['OWNER_NAME', 'owner_name', 'owner'] },
  { header: 'Contractor', keys: ['CONTRACTOR_NAME', 'contractor_name', 'contractor'] },
  { header: 'Description', keys: ['PERMIT_DESCRIPTION', 'permit_description', 'description'] },
  { header: 'Work Description', keys: ['WORK_DESCRIPTION', 'work_description'] },
  { header: 'Trade', keys: ['trade', 'TRADE'] },
  { header: 'Status', keys: ['STATUS', 'status'] },
  { header: 'Issue Date', keys: ['LAST_ISSUED_DATE', 'last_issued_date', 'permit_date', 'issue_date'], date: true },
  { header: 'Valuation', keys: ['FINAL_VALUATION', 'final_valuation', 'value', 'valuation'] },
];

/** First present value across candidate keys. Preserves 0; missing/null/undefined/'' → ''. */
function pick(row: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    const v = row?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

/** Consistent date formatting → YYYY-MM-DD for common inputs; otherwise the trimmed original. */
export function formatDate(v: any): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return s;
}

/**
 * RFC4180-style field escaping + spreadsheet-formula-injection guard.
 * - null/undefined → '' ; numeric 0 → "0" (preserved)
 * - values beginning with = + - @ are prefixed with a single quote so spreadsheets don't execute them
 * - fields containing comma / double-quote / CR / LF are wrapped in quotes; embedded " → ""
 */
export function escapeCsvField(raw: any): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;              // formula-injection neutralization
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize authorized/filtered permit rows to CSV text (UTF-8, CRLF line endings). Pure. */
export function buildPermitCsv(rows: Record<string, any>[]): string {
  const header = COLUMNS.map(c => escapeCsvField(c.header)).join(',');
  const body = (rows || []).map(row =>
    COLUMNS.map(c => {
      const v = c.date ? formatDate(pick(row, c.keys)) : pick(row, c.keys);
      return escapeCsvField(v);
    }).join(','),
  );
  return [header, ...body].join('\r\n');
}

/** Header names in export order — exposed for tests. */
export const CSV_HEADERS = COLUMNS.map(c => c.header);

function slug(s?: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Filename with active-filter context, e.g. permitmap_marion_generator_2026-07-30.csv.
 * County first, then trade (or keyword) as the context token; date passed in (caller supplies
 * today's date) for deterministic testing. All components are sanitized to [a-z0-9_].
 */
export function createExportFilename(
  filters: { county?: string; trade?: string; keyword?: string },
  date: string,
): string {
  const parts = ['permitmap'];
  const county = slug(filters.county);
  if (county) parts.push(county);
  const ctx = slug(filters.trade) || slug(filters.keyword);
  if (ctx) parts.push(ctx);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : slug(date);
  parts.push(d || 'export');
  return parts.join('_') + '.csv';
}
