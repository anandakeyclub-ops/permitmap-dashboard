// Shared types for the PermitMap dashboard.

// ── Saved Leads (Phase C) ─────────────────────────────────────────────────────

// Sales-pipeline stage for a saved lead. Mirrors the API's status CHECK constraint
// (saved_leads.status) exactly.
export type SavedLeadStatus = 'saved' | 'called' | 'quoted' | 'won' | 'lost';

// A saved lead as returned by permitmap-api's /saved-leads endpoints — all 13
// columns of the saved_leads table, in the API's JSON-serialised shape
// (value -> number, dates/timestamps -> ISO strings).
export interface SavedLead {
  id: string;
  contractor_id: string;
  permit_id: string;
  county: string;
  address: string;
  trade: string | null;
  value: number | null;
  permit_date: string | null;   // ISO date, e.g. "2026-05-28"
  score: number | null;
  status: SavedLeadStatus;
  notes: string | null;
  saved_at: string;             // ISO timestamp
  updated_at: string;           // ISO timestamp
}

// Per-stage pipeline totals returned alongside the lead list (always full-pipeline,
// independent of any active filter — drives the summary pills).
export type SavedLeadCounts = Record<SavedLeadStatus, number>;

// ── Permits ───────────────────────────────────────────────────────────────────

// A permit row from /permits or /permits/scored. Florida rows expose UPPERCASE
// fields; Texas rows expose lowercase — after the API's union mapping a row may
// carry either, so each known field is optional and dual-cased. The index
// signature keeps the many untyped fields the UI doesn't reference accessible.
export interface PermitRow {
  PERMITNO?: string;
  FULL_ADDRESS?: string;
  full_address?: string;
  ZIP?: string;
  zip?: string;
  FINAL_VALUATION?: string | number;
  final_valuation?: string | number;
  LAST_ISSUED_DATE?: string;
  last_issued_date?: string;
  OPENED_DATE?: string;        // opened-basis counties (e.g. Citrus) carry this instead of an issue date
  opened_date?: string;
  PERMIT_DESCRIPTION?: string;
  permit_description?: string;
  RECORD_TYPE?: string;
  record_type?: string;
  OWNER_NAME?: string;
  owner_name?: string;
  county?: string;
  trade?: string;
  score?: number;
  [key: string]: unknown;
}
