import { describe, expect, it } from 'vitest';
import type { SavedLead } from '../lib/types';

describe('saved lead explicit pipeline values', () => {
  it('keeps permit valuation distinct from contractor-entered revenue', () => {
    const lead: SavedLead = {
      id: '1', contractor_id: 'c', permit_id: 'p', county: 'palm_beach', address: '1 Main',
      trade: 'roofing', value: 50000, quoted_amount: 12000, won_amount: 10000,
      permit_date: '2026-09-17', score: 80, status: 'won', notes: null,
      saved_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-17T00:00:00Z',
    };
    expect(lead.value).toBe(50000);
    expect(lead.quoted_amount).toBe(12000);
    expect(lead.won_amount).toBe(10000);
  });
});
