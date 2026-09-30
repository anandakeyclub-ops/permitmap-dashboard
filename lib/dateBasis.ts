// Date-basis awareness. The API is the source of truth for WHICH date a county uses
// (coverage.date_basis) and HOW to label it (coverage.date_label). The dashboard NEVER
// decides the field — it renders whatever the API declares. This keeps future counties
// with different date semantics zero-code for the dashboard.
//
// - issued counties  -> effectivePermitDate = LAST_ISSUED_DATE (authoritative issue date)
// - opened counties  -> effectivePermitDate = OPENED_DATE       (record-opened date, e.g. Citrus)
// OPENED_DATE is never copied into an issue-date field and never fabricated.

export type DateBasis = 'issued' | 'opened';

// Candidate row keys per basis (UPPER_SNAKE + lowercase fallbacks), priority order.
export const DATE_BASIS_FIELDS: Record<DateBasis, string[]> = {
  issued: ['LAST_ISSUED_DATE', 'last_issued_date', 'ISSUED_DT', 'issued_dt', 'permit_date', 'issue_date'],
  opened: ['OPENED_DATE', 'opened_date'],
};

// Fallback labels when coverage.date_label is absent (e.g. coverage fetch failed).
export const DEFAULT_DATE_LABEL: Record<DateBasis, string> = {
  issued: 'Permit issued',
  opened: 'Record opened',
};

/** Normalize an arbitrary basis value to a supported DateBasis (defaults to 'issued'). */
export function normalizeBasis(basis: string | null | undefined): DateBasis {
  return basis === 'opened' ? 'opened' : 'issued';
}

/** The date to display/sort/export for a permit, per the county's configured basis.
 *  Returns the first present value across that basis's fields, or '' — never fabricated,
 *  never cross-copied from the other basis. */
export function effectivePermitDate(row: Record<string, any>, basis: string | null | undefined): string {
  for (const k of DATE_BASIS_FIELDS[normalizeBasis(basis)]) {
    const v = row?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** The label to show for the date dimension: coverage.date_label wins; else the basis default. */
export function dateLabel(coverage: { date_label?: string | null; date_basis?: string | null } | null | undefined): string {
  const lbl = coverage?.date_label;
  if (lbl && lbl.trim()) return lbl.trim();
  return DEFAULT_DATE_LABEL[normalizeBasis(coverage?.date_basis)];
}

/** The basis to use for a county from its coverage (defaults to 'issued' when unknown). */
export function basisOf(coverage: { date_basis?: string | null } | null | undefined): DateBasis {
  return normalizeBasis(coverage?.date_basis);
}
