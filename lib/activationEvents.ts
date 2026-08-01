// Pure, testable definitions + payload builders for the lifecycle ACTIVATION events the dashboard
// emits. No React, no fetch: the components call track() (lib/analytics) with what these builders
// return, so event names, payload shape, privacy, and the emit guards live in ONE tested place.
//
// Mirrors the server allowlist in permitmap-api (ACTIVATION_EVENTS). `permit_search` is deliberately
// ABSENT: the search box is live-filtered on every keystroke and has no committed-search contract
// yet — emitting it is a separate follow-up once that contract is designed.
//
// Privacy: payloads carry only county + non-sensitive identifiers/context (permit number, trade,
// tab, contractor name, result counts, sort/query text). Never owner name, full address, email,
// tokens, secrets, or whole permit rows. user/email/tier are derived server-side from the JWT.

import { saveLeadPermitId } from './saveLeadState';

export const ACTIVATION_EVENTS = [
  'dashboard_viewed',
  'permit_drawer_open',
  'contractor_profile_view',
  'csv_export',
  'saved_lead',
] as const;

export type ActivationEvent = (typeof ACTIVATION_EVENTS)[number];

// Structural subset of lib/analytics TrackProps — kept local so this module has no import cycle
// with analytics. Assignable to TrackProps (which only adds optional fields).
export interface ActivationEmit {
  event: ActivationEvent;
  props: { county?: string; properties?: Record<string, unknown> };
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const tradeOf = (p: Record<string, any>): string | null => p?.trade ?? null;

/**
 * dashboard_viewed guard: emit once per mount, and only after the county has resolved. The caller
 * owns the ref that persists `alreadyEmitted`; this encodes the "once + county-resolved" rule.
 */
export function shouldEmitDashboardView(alreadyEmitted: boolean, county: string): boolean {
  return !alreadyEmitted && !!county;
}

export function dashboardViewedEvent(county: string, activeTab: string, tier: string): ActivationEmit {
  return { event: 'dashboard_viewed', props: { county, properties: { active_tab: activeTab, tier } } };
}

export function permitDrawerOpenEvent(permit: Record<string, any>): ActivationEmit {
  return {
    event: 'permit_drawer_open',
    props: {
      county: str(permit?.county),
      properties: { permit_number: saveLeadPermitId(permit), trade: tradeOf(permit) },
    },
  };
}

/** permit_count is included only when the caller could derive it (via buildContractorProfile);
 *  pass null to omit it rather than duplicating contractor-matching logic. */
export function contractorProfileViewEvent(
  contractorName: string,
  county: string,
  permitCount: number | null,
): ActivationEmit {
  const properties: Record<string, unknown> = { contractor_name: contractorName };
  if (permitCount !== null) properties.permit_count = permitCount;
  return { event: 'contractor_profile_view', props: { county, properties } };
}

/** csv_export: returns null for an empty result set — encodes the "after the zero-results early
 *  return" rule so callers never emit for an empty export. */
export function csvExportEvent(
  rowCount: number,
  county: string,
  trade: string,
  query: string,
  sortOption: string,
): ActivationEmit | null {
  if (rowCount <= 0) return null;
  return {
    event: 'csv_export',
    props: { county, properties: { trade, query, row_count: rowCount, sort_option: sortOption } },
  };
}

export type SaveResult = { already_saved?: boolean };

/** saved_lead: build ONLY from a resolved save result (success or already_saved). Callers invoke
 *  this in the post-await success path, never in catch — so a failed save emits nothing. */
export function savedLeadEvent(res: SaveResult, permit: Record<string, any>): ActivationEmit {
  return {
    event: 'saved_lead',
    props: {
      county: str(permit?.county),
      properties: {
        permit_number: saveLeadPermitId(permit),
        trade: tradeOf(permit),
        outcome: res.already_saved ? 'already_saved' : 'saved',
      },
    },
  };
}
