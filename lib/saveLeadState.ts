// Pure, testable pieces of the existing Saved Leads "save" action — shared so the request body,
// permit identity, and dedup/loading rules are defined ONCE and reused by both the Opportunities
// star (via lib/api.ts::saveLead) and the Permit Detail Drawer's Save action. No React, no fetch,
// no storage. This introduces NO new persistence, status, route, or field — it only factors out
// logic that already existed inline, preserving the exact current behavior.

import type { PermitRow } from './types';

// The exact POST /saved-leads body (unchanged from the original inline shape in saveLead).
export interface SaveLeadBody {
  permit_id: string;
  county: string;
  address: string;
  trade: string | null;
  value: string | number | null;
  permit_date: string | null;
  score: number | null;
}

/** Permit identity used by the Saved Leads system. */
export function saveLeadPermitId(permit: Record<string, any>): string {
  return String(permit?.PERMITNO ?? '');
}

/** Build the exact existing /saved-leads request body from a permit row. Pure; never mutates. */
export function buildSaveLeadPayload(permit: PermitRow | Record<string, any>): SaveLeadBody {
  const p = permit as Record<string, any>;
  return {
    permit_id:   String(p.PERMITNO ?? ''),
    county:      String(p.county ?? ''),
    address:     String(p.FULL_ADDRESS ?? p.full_address ?? ''),
    trade:       p.trade ?? null,
    value:       p.FINAL_VALUATION ?? p.final_valuation ?? null,
    permit_date: p.LAST_ISSUED_DATE ?? p.last_issued_date ?? null,
    score:       p.score ?? null,
  };
}

/** Same dedup + loading guard the star uses: can only save a real, not-yet-saved, not-in-flight
 *  permit. (Tier eligibility is enforced separately by the caller.) */
export function canSaveLead(permitId: string, savedIds: Set<string>, savingId: string | null): boolean {
  return !!permitId && !savedIds.has(permitId) && savingId !== permitId;
}

export type SaveOutcome = 'success' | 'already_saved' | 'error';

/** Next savedIds set after a save resolves. success/already_saved → mark saved; error → unchanged.
 *  Returns a NEW set (never mutates the input), matching the star's optimistic-settle behavior. */
export function savedIdsAfter(savedIds: Set<string>, permitId: string, outcome: SaveOutcome): Set<string> {
  const next = new Set(savedIds);
  if (permitId && (outcome === 'success' || outcome === 'already_saved')) next.add(permitId);
  return next;
}
