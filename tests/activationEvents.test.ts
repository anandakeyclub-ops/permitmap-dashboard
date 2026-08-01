import { describe, it, expect } from 'vitest';
import {
  ACTIVATION_EVENTS,
  shouldEmitDashboardView,
  dashboardViewedEvent,
  permitDrawerOpenEvent,
  contractorProfileViewEvent,
  csvExportEvent,
  savedLeadEvent,
  type ActivationEvent,
} from '../lib/activationEvents';
import type { AnalyticsEvent } from '../lib/analytics';

// A permit shaped like the rows the dashboard passes around (only the fields the builders read).
const permit = {
  PERMITNO: 'BLD-123',
  county: 'miami-dade',
  trade: 'roofing',
  // Fields that MUST NOT leak into any payload:
  OWNER_NAME: 'Jane Homeowner',
  FULL_ADDRESS: '123 Private St',
  email: 'jane@example.com',
};

// Recursively collect every key present in a payload object (for privacy assertions).
function allKeys(obj: unknown, acc: string[] = []): string[] {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { acc.push(k.toLowerCase()); allKeys(v, acc); }
  }
  return acc;
}
const BANNED = ['owner', 'address', 'email', 'token', 'secret', 'authorization', 'bearer'];

describe('ACTIVATION_EVENTS taxonomy', () => {
  it('is exactly the five ratified raw signals', () => {
    expect([...ACTIVATION_EVENTS]).toEqual([
      'dashboard_viewed', 'permit_drawer_open', 'contractor_profile_view', 'csv_export', 'saved_lead',
    ]);
  });

  it('does NOT include permit_search (deferred) or any derived signal', () => {
    for (const absent of ['permit_search', 'first_search', 'last_active', 'returned_next_day']) {
      expect(ACTIVATION_EVENTS as readonly string[]).not.toContain(absent);
    }
  });

  it('every activation name is accepted by the client AnalyticsEvent type surface', () => {
    // Compile-time proof: each name is assignable to ActivationEvent AND AnalyticsEvent.
    const asActivation: ActivationEvent[] = [...ACTIVATION_EVENTS];
    const asAnalytics: AnalyticsEvent[] = [...ACTIVATION_EVENTS];
    expect(asActivation.length).toBe(5);
    expect(asAnalytics.length).toBe(5);
  });
});

describe('dashboard_viewed guard (ref-guarded, once per mount, after county resolves)', () => {
  it('does not emit before county resolves', () => {
    expect(shouldEmitDashboardView(false, '')).toBe(false);
  });
  it('emits once when county first resolves', () => {
    expect(shouldEmitDashboardView(false, 'miami-dade')).toBe(true);
  });
  it('never emits again once already emitted', () => {
    expect(shouldEmitDashboardView(true, 'miami-dade')).toBe(false);
  });
  it('builds the county + active_tab + tier payload', () => {
    const e = dashboardViewedEvent('miami-dade', 'permits', 'team');
    expect(e).toEqual({
      event: 'dashboard_viewed',
      props: { county: 'miami-dade', properties: { active_tab: 'permits', tier: 'team' } },
    });
  });
});

describe('permit_drawer_open', () => {
  it('carries county, permit_number (PERMITNO), and trade only', () => {
    const e = permitDrawerOpenEvent(permit);
    expect(e.event).toBe('permit_drawer_open');
    expect(e.props.county).toBe('miami-dade');
    expect(e.props.properties).toEqual({ permit_number: 'BLD-123', trade: 'roofing' });
  });
});

describe('contractor_profile_view', () => {
  it('includes permit_count when derivable', () => {
    const e = contractorProfileViewEvent('ACME Roofing', 'miami-dade', 12);
    expect(e.props.properties).toEqual({ contractor_name: 'ACME Roofing', permit_count: 12 });
  });
  it('omits permit_count when null (no duplicated aggregation)', () => {
    const e = contractorProfileViewEvent('ACME Roofing', 'miami-dade', null);
    expect(e.props.properties).toEqual({ contractor_name: 'ACME Roofing' });
    expect(e.props.properties).not.toHaveProperty('permit_count');
  });
});

describe('csv_export', () => {
  it('is NOT emitted for zero rows (returns null)', () => {
    expect(csvExportEvent(0, 'miami-dade', 'roofing', 'pool', 'newest')).toBeNull();
  });
  it('builds county + trade/query/row_count/sort_option for a real export', () => {
    const e = csvExportEvent(37, 'miami-dade', 'roofing', 'pool', 'newest');
    expect(e).toEqual({
      event: 'csv_export',
      props: { county: 'miami-dade', properties: { trade: 'roofing', query: 'pool', row_count: 37, sort_option: 'newest' } },
    });
  });
});

describe('saved_lead (only from a resolved result)', () => {
  it('maps a fresh save to outcome "saved"', () => {
    const e = savedLeadEvent({ already_saved: false }, permit);
    expect(e.event).toBe('saved_lead');
    expect(e.props.properties).toEqual({ permit_number: 'BLD-123', trade: 'roofing', outcome: 'saved' });
  });
  it('maps a duplicate save to outcome "already_saved"', () => {
    const e = savedLeadEvent({ already_saved: true }, permit);
    expect((e.props.properties as any).outcome).toBe('already_saved');
  });
});

describe('privacy — no sensitive fields in any activation payload', () => {
  it('never includes owner/address/email/token/secret keys', () => {
    const payloads = [
      dashboardViewedEvent('miami-dade', 'permits', 'team'),
      permitDrawerOpenEvent(permit),
      contractorProfileViewEvent('ACME', 'miami-dade', 3),
      csvExportEvent(5, 'miami-dade', 'roofing', 'jane@example.com is not a query', 'newest'),
      savedLeadEvent({ already_saved: false }, permit),
    ];
    for (const p of payloads) {
      const keys = allKeys(p);
      for (const banned of BANNED) expect(keys).not.toContain(banned);
    }
  });
});
