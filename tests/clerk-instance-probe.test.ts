import { describe, it, expect } from 'vitest';
import { timelineSummary } from '../scripts/forensics/clerk-instance-probe';
describe('timelineSummary', () => {
  it('groups by UTC day and reports bounds', () => {
    const t = (s: string) => Date.parse(s);
    const r = timelineSummary([t('2026-10-05T12:00:00Z'), t('2026-10-05T12:00:05Z'), t('2026-10-04T23:59:00Z')]);
    expect(r).toMatchObject({ count: 3, earliest: '2026-10-04T23:59:00.000Z', latest: '2026-10-05T12:00:05.000Z', by_day: { '2026-10-04': 1, '2026-10-05': 2 } });
  });
  it('handles an empty instance', () => { expect(timelineSummary([])).toEqual({ count: 0, earliest: null, latest: null, by_day: {} }); });
});
