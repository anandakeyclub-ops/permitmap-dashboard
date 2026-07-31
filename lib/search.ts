// Pure, testable keyword search over already-authorized permit records.
//
// The dashboard fetches permits per selected county from the API, which is
// entitlement-authoritative (non-entitled counties return preview_locked + zero rows).
// This filter runs ONLY over that already-returned, authorized list — it can never
// introduce non-entitled data. No API/DB change is required for this (the /permits
// endpoint has no keyword param, and the result set is small — capped display).
//
// Reused by CSV export (Item 3): export the SAME filtered result set.

// Logical search fields → candidate keys on the raw API permit object. Raw records use
// UPPER_SNAKE (e.g. PERMIT_DESCRIPTION); lowercase variants are accepted defensively,
// mirroring how the permit table renders (`p.FULL_ADDRESS || p.full_address`).
const SEARCH_FIELDS: string[][] = [
  ['PERMIT_DESCRIPTION', 'permit_description', 'description'],
  ['WORK_DESCRIPTION', 'work_description'],
  // Permit type / record type — curated vocabulary (e.g. "Residential Generator"). Some counties
  // carry the meaningful term here, not only in the description, so include it in the index.
  ['RECORD_TYPE', 'record_type', 'permit_type'],
  ['CONTRACTOR_NAME', 'contractor_name', 'contractor'],
  ['OWNER_NAME', 'owner_name', 'owner'],
  ['FULL_ADDRESS', 'full_address', 'address'],
  ['PERMITNO', 'permit_no', 'permit_number', 'permit_id'],
];

/** Combined lowercased text of the searchable fields (first present key per field). */
export function searchableText(permit: Record<string, any>): string {
  const parts: string[] = [];
  for (const keys of SEARCH_FIELDS) {
    for (const k of keys) {
      const v = permit?.[k];
      if (v != null && v !== '') { parts.push(String(v)); break; }
    }
  }
  return parts.join('  ').toLowerCase(); //  = field separator (never in user text)
}

/** Space-separated terms of a trimmed, lowercased query (empty array for blank query). */
export function queryTerms(query: string): string[] {
  return (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True iff EVERY term (AND semantics) is a case-insensitive partial (substring) match somewhere
 * in the combined searchable fields. A blank / whitespace-only query matches everything.
 */
export function matchesKeywords(permit: Record<string, any>, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const hay = searchableText(permit);
  return terms.every(t => hay.includes(t));
}

/**
 * Filter an already-authorized permit list by keyword query. Pure — the returned subset is
 * reused verbatim by CSV export. Blank query returns the input list unchanged (all currently
 * filtered results).
 */
export function filterByKeywords<T extends Record<string, any>>(permits: T[], query: string): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return permits;
  return permits.filter(p => matchesKeywords(p, query));
}
